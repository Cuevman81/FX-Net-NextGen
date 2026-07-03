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
- **AlertViz Notifications**: New Tornado, Severe Thunderstorm, and Flash Flood Warnings raise a corner toast (with an optional alert tone) so you don't have to watch the ticker. The toasts honor the Warnings state/WFO filter — nationwide when unfiltered, or only your selected state/office when narrowed. Warnings and Advisories/Statements are independent toggles.

### 📡 Full Radar Suite
- **National Reflectivity (MRMS)**: Seamless CONUS base-reflectivity mosaic.
- **Single-Site Products (NCEP)**: Per-site Reflectivity, Base Velocity, Hydrometeor Classification, Storm Total Precip, and One-Hour Precip pinned to the latest volume scan.
- **Dual-Pol, Velocity & Storm Tracks (NODD Level III)**: A **dependency-free, stdlib-only decoder** (`api/radar-l3.py`, validated byte-for-byte against MetPy) renders Correlation Coefficient (CC), Differential Reflectivity (ZDR), Specific Differential Phase (KDP), and **Storm Relative Velocity** — the last derived on the fly from the super-resolution base velocity (0.25 km / 0.5° / 256-level) for ~8× the detail of the legacy product-56 image. Products step through the lowest four elevation tilts, georeferenced as transparent PNG overlays with AWIPS-style color tables. Includes **Storm Tracks (STI)** with forecast positions and **VAD Wind Profiles** (winds aloft + hodograph).

### 🛰️ Satellite & Lightning
- **GOES-East (NASA GIBS)**: All ABI visible/water-vapor/infrared channels plus GeoColor composites, with smooth time-looping driven by real published frame times.
- **Lightning**: Near-real-time strike density (NLDN via nowCOAST).

### 🔥 Severe, Fire & Hydro Guidance
- **Storm Prediction Center (SPC)**: Day 1–3 Convective Outlooks (categorical), Day 1–2 probabilistic Tornado/Wind/Hail with significant-severe hatching, **Fire Weather Outlooks Day 1–8**, Mesoscale Discussions (MCDs), and Local Storm Reports (LSRs).
- **ProbSevere (CIMSS)**: Machine-learning storm objects colored by severe/hail/wind/tornado probability, refreshed every ~2 minutes; click a cell for the model's readout.
- **Weather Prediction Center (WPC)**: Surface isobars, high/low centers, coded fronts, QPF, **Excessive Rainfall Outlooks (ERO)**, and Mesoscale Precipitation Discussions (MPDs).
- **NHC-Style Discussion Popups**: Click any SPC/fire-weather/tropical area to open the official text discussion for that hazard in an in-app browser.
- **Fire & Smoke / Air Quality**: HMS smoke plumes, FIRMS active-fire detections, and AQI.
- **Rivers, Drought & Climate**: USGS/NWS river-gauge stages, US Drought Monitor, and CPC climate outlooks.

### 🌐 Observations, Soundings & Tools
- **National Hurricane Center (NHC)**: Tropical weather outlook areas, active storm cones, and forecast track points.
- **Aviation Weather (AWC)**: SIGMETs/AIRMETs, **Graphical AIRMETs (G-AIRMET)** hazard areas, Pilot Reports (PIREPs), and **Terminal Forecasts (TAF)** plotted by prevailing flight category (VFR/MVFR/IFR/LIFR) — click any for detail.
- **Surface Observations & Forecast Grids**: Real-time METAR plotting (temperature, dew point, pressure, wind barbs) with isobar/isotherm/isodrosotherm analysis, plus the **NDFD** surface-temperature forecast grid.
- **Interactive Skew-T (NSHARP-lite)**: A full radiosonde sounding for the site nearest the pane — high-resolution BUFR profile (thousands of levels) with standard-RAOB fallback, a lifted surface parcel with shaded CAPE on a real skew-T/log-P grid, wind barbs, and a 0–10 km hodograph. Computes SBCAPE/SBCIN (virtual-temperature corrected), Lifted Index, PWAT, LCL/LFC/EL, and 0–1 / 0–6 km bulk shear — all in-browser.
- **Solar Tools**: Day/Night terminator with a click-anywhere solar calculator (sunrise/sunset, twilight, solar noon, day length, declination).

---

## 🚀 Cloud Deployment (Vercel)
This project is configured for instant cloud hosting on **Vercel** with no managed backend:
- **Edge Rewrites (`vercel.json`)**: Bypass strict CORS on government servers by proxying NOAA/NWS/Aviation Weather Center endpoints at the global edge.
- **Serverless Python (`api/`)** — lightweight, dependency-light functions:
  - `radar-l3.py` — decodes NEXRAD Level III (NODD) dual-pol, storm-relative velocity, storm tracks & VAD to georeferenced PNGs/GeoJSON (stdlib + numpy/Pillow only; no MetPy).
  - `raob.py` — fetches the high-resolution BUFR radiosonde profile (University of Wyoming) with a decoded-RAOB fallback for the interactive Skew-T.
  - `spc-fire-wx.py`, `wpc-ero.py`, `wpc-mpd.py` — convert SPC/WPC KMZ products to GeoJSON on the fly (stdlib KML parser with XXE guards).
  - `probsevere.py` — locates and serves the newest CIMSS ProbSevere storm-object GeoJSON.
  - `nhc-two-atl.py`, `nhc-two-epac.py` — NHC Tropical Weather Outlook areas for the Atlantic & East Pacific.
  - `river-gauges.py`, `drought-monitor.py`, `gibs-times.py` — hydrology, drought GeoJSON, and live satellite frame-time discovery.
  - `log.py` — captures client diagnostics into the Vercel runtime console.
- **Edge-proxied feeds** — SIGMET/AIRMET, G-AIRMET, PIREP, TAF, METAR, WPC isobars/fronts, and NHC outlooks are proxied at the edge (`vercel.json` rewrites) to add the CORS headers those government servers omit.

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
