# FX-Net NextGen 🌪️
**Tactical Meteorological Workstation & Real-Time AWIPS Web Portal**

[![Deploy with Vercel](https://vercel.com/button)](https://fx-net-next-gen.vercel.app/)  
**Live Application:** [https://fx-net-next-gen.vercel.app/](https://fx-net-next-gen.vercel.app/)

---

## 👨‍💻 Overview & History
Developed by **Rodney Cuevas, Meteorologist**, **FX-Net NextGen** is a modern, lightning-fast web edition of NOAA’s legendary tactical field workstation.

In the late 1990s and 2000s, NOAA’s Forecast Systems Laboratory (FSL) engineered **FX-Net** as a lightweight client-server system allowing Incident Meteorologists (IMETs) at remote wildfires and field forecasters to access full AWIPS capabilities over low-bandwidth connections. 

**FX-Net NextGen** brings that exact tactical philosophy into the modern cloud era. Engineered with MapLibre GL JS, serverless edge routing, and direct government NOAA/NWS API integrations, this workstation provides forecasters with instant, synchronized multi-pane meteorological data without heavy local server requirements.

---

## ⚡ Key Features

### 🗺️ Multi-Pane Workspace
- **1 / 2 / 4-Pane Layouts**: Split the view into independent map panes, each with its own products, radar site, and animation state.
- **Workspace Tabs**: Save multiple labeled workspaces (double-click to rename, e.g. "Gulf Coast", "Severe Setup"); overlays persist across sessions.
- **Master Sync & Looping**: Lock all panes to a master view to compare radar, satellite, surface fronts, and severe outlooks over the exact same region — with synchronized time loops.
- **Per-Pane Legend & Data Health**: A live legend stack timestamps every active product (imagery valid time or last fetch), and a collapsible Data Health monitor groups every feed by category with red/amber/green status dots.

### 🚨 Real-Time Weather Alerts & Vector Watches
- **National Watchdog**: Polls official NWS feeds every 15 seconds for rapid convective updates. A live scrolling ticker surfaces new Tornado, Severe Thunderstorm, and Flash Flood warnings.
- **High-Fidelity Watch Vectors**: Integrates NOAA's REST MapServer feature service to draw county-precise polygon boundaries for Severe Thunderstorm and Tornado watches, with Impact-Based-Warning (IBW) pulse styling for Considerable/Catastrophic tags.
- **Universal Point Query**: Click anywhere inside an alert to query the NWS active-alerts database and render color-coded, stacked HTML bulletins with full precautionary actions.

### 📡 Full Radar Suite
- **National Reflectivity (MRMS)**: Seamless CONUS base-reflectivity mosaic.
- **Single-Site Products (NCEP)**: Per-site Reflectivity, Base Velocity, Hydrometeor Classification, Storm Total Precip, and One-Hour Precip pinned to the latest volume scan.
- **Dual-Pol & Velocity (NODD Level III)**: A **dependency-free, stdlib-only decoder** (`api/radar-l3.py`, validated byte-for-byte against MetPy) renders Correlation Coefficient (CC), Differential Reflectivity (ZDR), Specific Differential Phase (KDP), and true **Storm Relative Velocity (SRM, product 56)** — at the 0.5° tilt, georeferenced as transparent PNG overlays with AWIPS-style color tables.

### 🛰️ Satellite & Lightning
- **GOES-East (NASA GIBS)**: All ABI visible/water-vapor/infrared channels plus GeoColor composites, with smooth time-looping driven by real published frame times.
- **Lightning**: Near-real-time strike density (NLDN via nowCOAST).

### 🔥 Severe, Fire & Hydro Guidance
- **Storm Prediction Center (SPC)**: Day 1–3 Convective Outlooks (categorical), Day 1–2 probabilistic Tornado/Wind/Hail with significant-severe hatching, **Fire Weather Outlooks Day 1–8**, and Mesoscale Discussions (MCDs).
- **Weather Prediction Center (WPC)**: Surface isobars, high/low centers, coded fronts, QPF, **Excessive Rainfall Outlooks (ERO)**, and Mesoscale Precipitation Discussions (MPDs).
- **NHC-Style Discussion Popups**: Click any SPC/fire-weather/tropical area to open the official text discussion for that hazard in an in-app browser.
- **Fire & Smoke / Air Quality**: HMS smoke plumes, FIRMS active-fire detections, and AQI.
- **Rivers, Drought & Climate**: USGS/NWS river-gauge stages, US Drought Monitor, and CPC climate outlooks.

### 🌐 Observations, Soundings & Tools
- **National Hurricane Center (NHC)**: Tropical weather outlook areas, active storm cones, and forecast track points.
- **Surface Observations**: Real-time METAR plotting (temperature, dew point, pressure, wind barbs) plus isobar/isotherm/isodrosotherm analysis.
- **Interactive Soundings**: Clickable Skew-T log-P viewer across US sounding sites.
- **Solar Tools**: Day/Night terminator with a click-anywhere solar calculator (sunrise/sunset, twilight, solar noon, day length, declination).

---

## 🚀 Cloud Deployment (Vercel)
This project is configured for instant cloud hosting on **Vercel** with no managed backend:
- **Edge Rewrites (`vercel.json`)**: Bypass strict CORS on government servers by proxying NOAA/NWS/Aviation Weather Center endpoints at the global edge.
- **Serverless Python (`api/`)** — lightweight, dependency-light functions:
  - `radar-l3.py` — decodes NEXRAD Level III (NODD) dual-pol & storm-relative velocity to georeferenced PNGs (stdlib + numpy/Pillow only; no MetPy).
  - `spc-fire-wx.py`, `wpc-ero.py`, `wpc-mpd.py` — convert SPC/WPC KMZ products to GeoJSON on the fly (stdlib KML parser with XXE guards).
  - `nhc-two-atl.py`, `nhc-two-epac.py` — NHC Tropical Weather Outlook areas for the Atlantic & East Pacific.
  - `river-gauges.py`, `drought-monitor.py`, `gibs-times.py` — hydrology, drought GeoJSON, and live satellite frame-time discovery.
  - `log.py` — captures client diagnostics into the Vercel runtime console.

---

## 💻 Local Development
To run the workstation locally on your macOS or Linux machine with full functionality:

```bash
# 1. Clone the repository
git clone https://github.com/Cuevman81/FX-Net-NextGen.git
cd FX-Net-NextGen

# 2. Start the local Python proxy server (Port 8888)
python3 server.py
```
Open your browser and navigate to [http://localhost:8888](http://localhost:8888).

---

## 📄 Legal & Disclaimer
Terminology, data feeds, and acronyms (AWIPS, FX-Net, WPC, SPC, NHC, METAR) are public domain properties of the United States Government (NOAA / National Weather Service) pursuant to 17 U.S.C. § 105. 

*Designed and maintained as an independent professional forecasting tool by Rodney Cuevas.*
