import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";
import mapboxgl from "https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm";

const BOSTON_BIKE_LANES_URL =
  "https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson";
const CAMBRIDGE_BIKE_LANES_URL =
  "https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson";
const BLUEBIKES_STATIONS_URL =
  "https://dsc106.com/labs/lab07/data/bluebikes-stations.json";
const BLUEBIKES_TRAFFIC_URL =
  "https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv";

let map;
let departuresByMinute = Array.from({ length: 1440 }, () => []);
let arrivalsByMinute = Array.from({ length: 1440 }, () => []);

const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);
const bikeLanePaint = {
  "line-color": "#16a34a",
  "line-width": 3,
  "line-opacity": 0.55,
};

console.log("Mapbox GL JS Loaded:", mapboxgl);

function getMapboxToken() {
  return (
    window.MAPBOX_ACCESS_TOKEN ||
    localStorage.getItem("mapboxToken") ||
    new URLSearchParams(window.location.search).get("token") ||
    ""
  ).trim();
}

function getCoords(station) {
  const point = new mapboxgl.LngLat(+station.lon, +station.lat);
  const { x, y } = map.project(point);
  return { cx: x, cy: y };
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes);
  return date.toLocaleString("en-US", { timeStyle: "short" });
}

function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) {
    return tripsByMinute.flat();
  }

  const minMinute = (minute - 60 + 1440) % 1440;
  const maxMinute = (minute + 60) % 1440;

  if (minMinute > maxMinute) {
    return tripsByMinute
      .slice(minMinute)
      .concat(tripsByMinute.slice(0, maxMinute))
      .flat();
  }

  return tripsByMinute.slice(minMinute, maxMinute).flat();
}

function computeStationTraffic(stations, timeFilter = -1) {
  const departures = d3.rollup(
    filterByMinute(departuresByMinute, timeFilter),
    (v) => v.length,
    (d) => d.start_station_id,
  );

  const arrivals = d3.rollup(
    filterByMinute(arrivalsByMinute, timeFilter),
    (v) => v.length,
    (d) => d.end_station_id,
  );

  return stations.map((station) => {
    const id = station.short_name;
    return {
      ...station,
      arrivals: arrivals.get(id) ?? 0,
      departures: departures.get(id) ?? 0,
      totalTraffic: (arrivals.get(id) ?? 0) + (departures.get(id) ?? 0),
    };
  });
}

function setTooltip(selection) {
  selection.select("title").remove();
  selection.append("title").text(
    (d) =>
      `${d.name}\n${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`,
  );
}

function tooltipHtml(station) {
  return `
    <strong>${station.name}</strong>
    ${station.totalTraffic} trips
    (${station.departures} departures, ${station.arrivals} arrivals)
  `;
}

function departureRatio(station) {
  return station.totalTraffic ? station.departures / station.totalTraffic : 0.5;
}

async function loadTrips() {
  departuresByMinute = Array.from({ length: 1440 }, () => []);
  arrivalsByMinute = Array.from({ length: 1440 }, () => []);

  return d3.csv(BLUEBIKES_TRAFFIC_URL, (trip) => {
    trip.started_at = new Date(trip.started_at);
    trip.ended_at = new Date(trip.ended_at);

    departuresByMinute[minutesSinceMidnight(trip.started_at)].push(trip);
    arrivalsByMinute[minutesSinceMidnight(trip.ended_at)].push(trip);

    return trip;
  });
}

function addBikeLaneLayer(sourceId, layerId, dataUrl) {
  map.addSource(sourceId, {
    type: "geojson",
    data: dataUrl,
  });

  map.addLayer({
    id: layerId,
    type: "line",
    source: sourceId,
    paint: bikeLanePaint,
  });
}

async function initialize() {
  const token = getMapboxToken();
  const tokenMessage = document.getElementById("token-message");
  const loadingMessage = document.getElementById("loading-message");

  if (!token) {
    tokenMessage.hidden = false;
    loadingMessage.hidden = true;
    return;
  }

  mapboxgl.accessToken = token;

  map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/streets-v12",
    center: [-71.09415, 42.36027],
    zoom: 12,
    minZoom: 5,
    maxZoom: 18,
  });

  map.addControl(new mapboxgl.NavigationControl(), "bottom-right");

  map.on("load", async () => {
    addBikeLaneLayer(
      "boston-route",
      "boston-bike-lanes",
      BOSTON_BIKE_LANES_URL,
    );
    addBikeLaneLayer(
      "cambridge-route",
      "cambridge-bike-lanes",
      CAMBRIDGE_BIKE_LANES_URL,
    );

    try {
      const [jsonData] = await Promise.all([
        d3.json(BLUEBIKES_STATIONS_URL),
        loadTrips(),
      ]);
      console.log("Loaded JSON Data:", jsonData);

      const baseStations = jsonData.data.stations;
      let stations = computeStationTraffic(baseStations);
      console.log("Stations Array:", stations);

      const mapContainer = document.getElementById("map");
      const svg = d3.select("#map").select("svg");
      const stationTooltip = d3.select("#station-tooltip");
      const radiusScale = d3
        .scaleSqrt()
        .domain([0, d3.max(stations, (d) => d.totalTraffic)])
        .range([0, 25]);

      const circles = svg
        .selectAll("circle")
        .data(stations, (d) => d.short_name)
        .enter()
        .append("circle")
        .attr("r", (d) => radiusScale(d.totalTraffic))
        .style("--departure-ratio", (d) => stationFlow(departureRatio(d)))
        .on("pointerenter mouseenter", (event, d) => {
          stationTooltip.html(tooltipHtml(d)).attr("hidden", null);
        })
        .on("pointermove mousemove", (event) => {
          stationTooltip
            .style("left", `${event.offsetX}px`)
            .style("top", `${event.offsetY}px`);
        })
        .on("pointerleave mouseleave", () => {
          stationTooltip.attr("hidden", true);
        })
        .call(setTooltip);

      function updatePositions() {
        circles
          .attr("cx", (d) => getCoords(d).cx)
          .attr("cy", (d) => getCoords(d).cy);
      }

      function updateScatterPlot(timeFilter) {
        const filteredStations = computeStationTraffic(baseStations, timeFilter);
        radiusScale
          .domain([0, d3.max(filteredStations, (d) => d.totalTraffic)])
          .range(timeFilter === -1 ? [0, 25] : [3, 50]);

        circles
          .data(filteredStations, (d) => d.short_name)
          .attr("r", (d) => radiusScale(d.totalTraffic))
          .style("--departure-ratio", (d) => stationFlow(departureRatio(d)))
          .call(setTooltip);

        stations = filteredStations;
        updatePositions();
      }

      function updateStationTooltip(event) {
        const { left, top } = mapContainer.getBoundingClientRect();
        const pointer = {
          x: event.clientX - left,
          y: event.clientY - top,
        };

        let closestStation;
        let closestDistance = Infinity;

        for (const station of stations) {
          const coords = getCoords(station);
          const distance = Math.hypot(
            pointer.x - coords.cx,
            pointer.y - coords.cy,
          );
          const hitRadius = Math.max(radiusScale(station.totalTraffic) + 6, 18);

          if (distance <= hitRadius && distance < closestDistance) {
            closestStation = station;
            closestDistance = distance;
          }
        }

        if (!closestStation) {
          stationTooltip.attr("hidden", true);
          return;
        }

        stationTooltip
          .html(tooltipHtml(closestStation))
          .style("left", `${pointer.x}px`)
          .style("top", `${pointer.y}px`)
          .attr("hidden", null);
      }

      const timeSlider = document.getElementById("time-slider");
      const selectedTime = document.getElementById("selected-time");
      const anyTimeLabel = document.getElementById("any-time");

      function updateTimeDisplay() {
        const timeFilter = Number(timeSlider.value);

        if (timeFilter === -1) {
          selectedTime.textContent = "";
          anyTimeLabel.style.display = "block";
        } else {
          selectedTime.textContent = formatTime(timeFilter);
          anyTimeLabel.style.display = "none";
        }

        updateScatterPlot(timeFilter);
      }

      updatePositions();
      updateTimeDisplay();

      map.on("move", updatePositions);
      map.on("zoom", updatePositions);
      map.on("resize", updatePositions);
      map.on("moveend", updatePositions);
      timeSlider.addEventListener("input", updateTimeDisplay);
      mapContainer.addEventListener("mousemove", updateStationTooltip);
      mapContainer.addEventListener("mouseleave", () => {
        stationTooltip.attr("hidden", true);
      });

      loadingMessage.hidden = true;
      console.log("Trips loaded:", departuresByMinute.flat().length);
      console.log("Current stations:", stations);
    } catch (error) {
      loadingMessage.textContent = "Could not load bike traffic data. Check the console.";
      console.error("Error loading data:", error);
    }
  });
}

initialize();
