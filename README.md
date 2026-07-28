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
- **1 / 2 / 4 / 8-Pane Layouts**: Split the view into independent map panes, each with its own products, radar site, and animation state.
- **Product Filter**: A search box above the sidebar filters all ~136 products by name or category, auto-opening matching groups — no scrolling through 18 collapsed categories to find a product.
- **Workspace Tabs & Autosave**: Save multiple labeled workspaces (double-click to rename, e.g. "Gulf Coast", "Severe Setup"). The whole workspace autosaves every 15 seconds and on close — every pane's map view, radar/satellite imagery, and overlay products (warnings, outlooks, obs, aviation…) come back exactly as you left them on reload, and the NWS Warnings state/WFO filter is remembered too. A Settings Export/Import (under ANALYSIS TOOLS) writes all saved settings — workspaces, procedures, filters, preferences — to a JSON file for backup or moving between browsers/machines.
- **Master Sync & Looping**: Lock all panes to a master view to compare radar, satellite, surface fronts, and severe outlooks over the exact same region — with synchronized time loops that wait for every pane to preload before rolling.
- **Time-Matched Loops (AWIPS-style)**: Products publish at different cadences — radar every 5 minutes, GIBS satellite every 10, dual-pol on its own volume-scan schedule. Rather than stepping each stream by position, the loop builds a master timeline and shows every product **the frame that was actually valid at that time**, so a coarse stream holds instead of racing ahead. Where a stream's newest frame lags real time (satellite typically runs 30–40 minutes behind), it holds on that frame and the per-pane label reports the true valid time.
- **Keyboard Loop Control**: `Space` play/pause · `←`/`→` step frames · `Home`/`End` oldest/newest · `Esc` stop · `1`–`8` select a pane. Arrow keys are only claimed while a loop is running, so they otherwise pan the map. Loop **MODE** (Forward or Rock) and **DWELL** (extra hold on the newest frame) are in the bottom toolbar.
- **Per-Pane Legend & Data Health**: A live legend stack timestamps every active product (imagery valid time or last fetch), and a collapsible Data Health monitor groups every feed by category with red/amber/green status dots.

### 🚨 Real-Time Weather Alerts & Vector Watches
- **National Watchdog**: Polls official NWS feeds every 15 seconds for rapid convective updates. A live scrolling ticker surfaces new Tornado, Severe Thunderstorm, and Flash Flood warnings.
- **High-Fidelity Watch Vectors**: Integrates NOAA's REST MapServer feature service to draw county-precise polygon boundaries for Severe Thunderstorm and Tornado watches, with Impact-Based-Warning (IBW) pulse styling for Considerable/Catastrophic tags.
- **Universal Point Query**: Click anywhere inside an alert to query the NWS active-alerts database and render color-coded, stacked HTML bulletins with full precautionary actions.
- **AlertViz Notifications**: New Tornado, Severe Thunderstorm, and Flash Flood Warnings raise a corner toast (with an optional alert tone) so you don't have to watch the ticker. The toasts honor the Warnings state/WFO filter — nationwide when unfiltered, or only your selected state/office when narrowed. Warnings and Advisories/Statements are independent toggles.

### 📡 Full Radar Suite
- **National Reflectivity (MRMS)**: Seamless CONUS base-reflectivity mosaic.
- **Single-Site Products (NCEP)**: Per-site Reflectivity, Base Velocity, Hydrometeor Classification, Storm Total Precip, and One-Hour Precip pinned to the latest volume scan.
- **Dual-Pol, Velocity & Storm Tracks (NODD Level III)**: A **dependency-free, stdlib-only decoder** (`api/radar-l3.py`, validated byte-for-byte against MetPy) renders Correlation Coefficient (CC), Differential Reflectivity (ZDR), Specific Differential Phase (KDP), and **Storm Relative Velocity** — the last derived on the fly from the super-resolution base velocity (0.25 km / 0.5° / 256-level) for ~8× the detail of the legacy product-56 image. Products step through the lowest four elevation tilts, georeferenced as transparent PNG overlays with AWIPS-style color tables. Includes **Storm Tracks (STI)** with forecast positions, **Meso/TVS markers (MDA)** colored by strength rank, and **VAD Wind Profiles** (winds aloft + hodograph).

### 🛰️ Satellite & Lightning
- **GOES-East & GOES-West, organized by sector**: A per-panel **SECTOR** selector picks the satellite and scan area together — GOES-East (CONUS, Full Disk, Puerto Rico / Caribbean, Mesoscale 1 & 2) and GOES-West (PACUS, Full Disk, Hawaii, Alaska, Mesoscale 1 & 2). Eleven sectors, all 16 ABI channels on each, so the eastern Pacific can sit beside the Atlantic in a multi-pane layout.
- **One-minute mesoscale floaters**: The fastest imagery GOES produces, repositioned by NWS/NHC over active hurricanes, severe outbreaks and fires. Because they roam, FX-Net derives each sector's true footprint at runtime from the imagery's world file and PNG header via an inverse geostationary projection, and zooms straight to it.
- **Sector-matched refresh**: Mesoscale re-pulls every minute, CONUS/PACUS every 5, full disk every 10 — the rate the ABI actually scans. Each panel's legend carries the bird, the sector and that sector's exact image valid time.
- **Loopable NASA GIBS products** (GeoColor, Clean IR, Red Visible, Air Mass, Dust, Fire Temp) for both birds, with smooth time-looping driven by real published frame times and full-disk coverage including the southern hemisphere.
- **Lightning**: Near-real-time strike density (NLDN via nowCOAST).

### 📈 Model Guidance & MOS
- **Forecast soundings**: the Skew-T panel takes an **observed RAOB** or a **model forecast sounding** from **HRRR** (3 km, hourly, to 48 h) or **GFS** (to 5 days), stepped by forecast hour and cached so scrubbing is free. SBCAPE, CIN, Lifted Index, PWAT, LCL/LFC/EL, 0–1 and 0–6 km shear, wind barbs and the hodograph are computed identically for both, so the balloon and the model can be compared directly at the same site.
  Forecast soundings are **not limited to the ~57 balloon sites** — a model has a profile at every grid point, so the location box takes any airport id (`KMEM`, `KGPT`), ZIP, city, or `lat,lon`, and blank uses the active pane's centre. Resolution is cheapest-first: the RAOB table, then the in-memory ASOS set, then IEM station metadata, then geocoding.
- **Model Comparison**: **GFS** (NCEP), **HRRR** (NCEP 3 km), **ECMWF IFS**, **CMC GEM** (ECCC), **ICON** (DWD) and **ECMWF AIFS** — ECMWF's operational AI model — plotted together at a point for temperature, dewpoint, wind, precip or MSLP out to 7 days. The shaded band is the inter-model **spread envelope**, with mean and worst-case disagreement called out, because model agreement is the confidence signal rather than any single deterministic run. AIFS draws dashed so it reads apart from the physics runs.
- **MOS Guidance**: MDL station bulletins in their issued layout — parameters down the left, forecast projections across. **GFS MOS (MAV)**, **GFS Extended (MEX)**, **LAMP** (hourly-updating, usually the freshest guidance available), **NBM Short/Extended**, and **NAM MOS** flagged with its `2026-10-06 12 UTC` retirement. *Nearest* resolves the closest ASOS to the panel centre from the loaded METAR set.
  There is no standalone HRRR MOS — **LAMP _is_ the HRRR-based station guidance**, since MDL melds HRRR into its ceiling, visibility and conditional CIG/VIS elements. Its 1-hour convection and lightning rows (`CP1`/`CC1`, `LP1`/`LC1` — probability and N/L/M/H potential out to 25 h) are shown alongside the aviation elements.
- **Deliberately point-based, never gridded.** There is no free CORS-open gridded source for these models (NOAA IDP-GIS publishes no model layers; Unidata's THREDDS serves GFS but sends no CORS header), and browser-side GRIB decoding is precisely the AWIPS ingest burden this app avoids. A coarse-grid contour approach was built and measured first — it rate-limited at roughly 30 map draws per day. Point guidance costs about a thousandth of that. Both panels fetch **only when opened**: no polling, no map layers, no background traffic.

### 🔥 Severe, Fire & Hydro Guidance
- **Storm Prediction Center (SPC)**: Day 1–3 Convective Outlooks (categorical), **Day 4–8 Severe Outlook**, Day 1–2 probabilistic Tornado/Wind/Hail with significant-severe hatching, **Fire Weather Outlooks Day 1–8**, Mesoscale Discussions (MCDs), Local Storm Reports (LSRs), and an **SPC Mesoanalysis viewer** — the full SPC catalog (~140 parameters across 11 categories: surface, upper-air analyses from 925–300 mb with frontogenesis and jet dynamics, thermodynamics, wind shear, composite indices, multi-parameter fields, heavy rain, winter weather, and fire weather) over 11 selectable sectors.
- **ProbSevere (CIMSS)**: Machine-learning storm objects colored by severe/hail/wind/tornado probability, refreshed every ~2 minutes; click a cell for the model's readout.
- **Weather Prediction Center (WPC)**: Surface isobars, high/low centers, coded fronts, QPF, **Excessive Rainfall Outlooks (ERO)**, and Mesoscale Precipitation Discussions (MPDs).
- **NHC-Style Discussion Popups**: Click any SPC/fire-weather/tropical area to open the official text discussion for that hazard in an in-app browser.
- **Fire & Smoke / Air Quality**: HMS smoke plumes, FIRMS active-fire detections, and AQI.
- **Rivers, Drought & Climate**: USGS/NWS river-gauge stages, US Drought Monitor, and CPC climate outlooks.

### 🌀 Tropical — NHC, Recon & Model Guidance
The whole tropical section follows **one active storm**: picking a system in either storm dropdown switches guidance, trends, diagnostics, advisories, and recon together.

- **Active Storms & Cones with automatic source failover**: The forecast cone, track, and coastal watches/warnings normally come from NOAA's tropical GIS service — which can stall for many hours (observed ~22 h behind on Jul 21 2026, still showing TD Two #5 when NHC had Bertha at #8A). Every refresh cross-checks that feed's advisory numbers against NHC's authoritative storm index; when it's behind or unreachable, FX-Net **fails over to NHC's own advisory KMZ graphics** (CORS-open, regenerated on intermediate advisories too), badges the source **NHC DIRECT**, and reverts automatically once NOAA catches up. Watch/warning segments are colored by hazard (TS Watch, TS Warning, Hurricane Watch, Hurricane Warning).
- **Official Text Products, per storm**: Public Advisory (TCP), Forecast Discussion (TCD), Forecast/Advisory (TCM), and Wind Speed Probabilities (PWS), resolved through the storm's rotating AWIPS bin.
- **Hurricane Hunters (Recon)**: Live HDOB flight observations plotted along the aircraft track, the daily TCPOD flight schedule, and Vortex Data Messages. Flights are matched to storms by proximity (the HDOB storm field is often a `CYCLONE` placeholder), and an **IN AIR** badge shows solid green when aircraft are working your selected storm, dimmed when they're up elsewhere.
- **Model Guidance (Spaghetti)**: Live ATCF a-deck tracks — Early Cycle, Late Cycle, and GEFS ensemble members — plus dedicated **AI/ML sub-tabs** (GraphCast/GDMI, neural-net intensity consensus, and NHC's wider AI suite wired for when it reaches public decks).
- **Intensity Guidance & Trends**: Early/Late cycle intensity charts, **Storm Trends** (observed intensity history from best track plus recon fixes), and **Forecast History** — every past advisory's official forecast track overlaid on the storm's actual traveled path, faded by recency, so run-to-run trend is visible at a glance.
- **Environment / RI (SHIPS)**: SHIPS environmental diagnostics folded together with CIRA rapid-intensification and decapitation guidance.
- **Tropical Weather Outlooks**: Atlantic and East Pacific TWO areas and discussion text.

### 🌐 Observations, Soundings & Tools
- **Aviation Weather (AWC)**: SIGMETs/AIRMETs, **Graphical AIRMETs (G-AIRMET)** hazard areas, Pilot Reports (PIREPs), **Center Weather Advisories (CWA)**, and **Terminal Forecasts (TAF)** plotted by prevailing flight category (VFR/MVFR/IFR/LIFR) — click any for detail.
- **Surface & Marine Observations, Forecast Grids**: Real-time METAR plotting (temperature, dew point, pressure, wind barbs) with isobar/isotherm/isodrosotherm analysis, **NDBC marine buoys** (~700 coastal/offshore stations), plus the **NDFD** surface-temperature forecast grid.
- **Interactive Skew-T (NSHARP-lite)**: A full radiosonde sounding for the site nearest the pane — high-resolution BUFR profile (thousands of levels) with standard-RAOB fallback, a lifted surface parcel with shaded CAPE on a real skew-T/log-P grid, wind barbs, and a 0–10 km hodograph. Computes SBCAPE/SBCIN (virtual-temperature corrected), Lifted Index, PWAT, LCL/LFC/EL, and 0–1 / 0–6 km bulk shear — all in-browser.
- **Solar Tools**: Day/Night terminator with a click-anywhere solar calculator (sunrise/sunset, twilight, solar noon, day length, declination).
- **Analysis Tools**: Distance/bearing measure, site range rings, and a storm-motion/ETA tool.
- **Procedures**: Save the current multi-pane display — layout, per-pane view, imagery, and overlays — as a named bundle and reload it in one click.
- **NWS Text Products**: A Text Browser for any WFO or national center (with product history), and a **Forecast Meteogram** charting the NWS hourly forecast for any point.
- **Built-in Documentation**: A full-screen **User Guide** with table of contents and live search, plus a **What's New** changelog in the sidebar that surfaces each release once.

---

## 🚀 Cloud Deployment (Vercel)
This project is configured for instant cloud hosting on **Vercel** with no managed backend:
- **Edge Rewrites (`vercel.json`)**: Bypass strict CORS on government servers by proxying NOAA/NWS/Aviation Weather Center endpoints at the global edge.
- **Serverless Python (`api/`)** — ten lightweight, dependency-light functions:
  - `radar-l3.py` — decodes NEXRAD Level III (NODD) dual-pol, storm-relative velocity, storm tracks & VAD to georeferenced PNGs/GeoJSON (stdlib + numpy/Pillow only; no MetPy).
  - `adeck.py` — the tropical workhorse. Proxies ATCF decks and NHC indexes that send no CORS headers: a-deck model guidance (`?id=`), the run-to-run official forecast history (`?fcst=`), best track (`?btk=`), SHIPS (`?ships=`), CIRA RI guidance (`?rip=`), the active-storm index with AWIPS bins (`?nhc=`/`?list=`), and the NHC advisory-graphics KMZ fetch-and-unzip backstop (`?gis=`).
  - `raob.py` — fetches the high-resolution BUFR radiosonde profile (University of Wyoming) with a decoded-RAOB fallback for the interactive Skew-T.
  - `spc-fire-wx.py`, `wpc-ero.py`, `wpc-mpd.py` — convert SPC/WPC KMZ products to GeoJSON on the fly (stdlib KML parser with XXE guards).
  - `probsevere.py` — locates and serves the newest CIMSS ProbSevere storm-object GeoJSON.
  - `river-gauges.py`, `drought-monitor.py`, `gibs-times.py` — hydrology, drought GeoJSON, and live satellite frame-time discovery.
- **Edge-proxied feeds** — SIGMET/AIRMET, G-AIRMET, PIREP, TAF, CWA, METAR, NDBC, WPC isobars/fronts, and the NHC Tropical Weather Outlooks are pass-through `vercel.json` rewrites rather than functions, adding the CORS headers those government servers omit while staying under Vercel Hobby's 12-function ceiling.

### 🔒 Hardening
- **Strict Content-Security-Policy** with no `'unsafe-inline'` in `script-src`, so an injected inline handler arriving through a malformed or compromised upstream feed cannot execute. The policy is mirrored byte-for-byte in `server.py` so violations surface in local development rather than first appearing in production.
- **Vendored dependencies** — MapLibre GL JS and Lucide are pinned and self-hosted (`vendor/`), so a CDN outage or a mutated `@latest` release can neither break nor tamper with the app.
- **Feed text is escaped** everywhere it reaches a popup or panel; upstream data is never trusted as markup.
- **Every network call has a deadline**, so a hung government endpoint can't leave requests pending indefinitely or stack repeats behind itself; fast pollers are additionally guarded against overlapping themselves.
- **Proxies validate their inputs** — storm IDs, station codes, and layer names are pattern-matched and numeric parameters clamped before they reach a URL. Upstream failures are logged server-side and returned to the browser generically, so internal URLs and paths never appear in a client response.

---

## 💻 Local Development
To run the workstation locally on your macOS or Linux machine with full functionality:

```bash
# 1. Clone the repository
git clone https://github.com/Cuevman81/FX-Net-NextGen.git
cd FX-Net-NextGen

# 2. Install the two binary dependencies the Level III radar decoder needs
pip3 install -r requirements.txt

# 3. Start the local Python proxy server (Port 8888)
python3 server.py
```
Open your browser and navigate to [http://localhost:8888](http://localhost:8888).

`server.py` mirrors the production routing — it runs the same `api/*.py` handlers, applies the same `vercel.json` pass-through proxies, and sends the same Content-Security-Policy — so what works locally is what deploys. Everything except the Level III radar products works without the two dependencies above; the rest of the app is stdlib-only.

---

## 📄 Legal & Disclaimer
Terminology, data feeds, and acronyms (AWIPS, FX-Net, WPC, SPC, NHC, METAR) are public domain properties of the United States Government (NOAA / National Weather Service) pursuant to 17 U.S.C. § 105. 

*Designed and maintained as an independent professional forecasting tool by Rodney Cuevas.*
