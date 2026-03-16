# URL Grepper Chrome Extension


# New features:
- scan a finite amount on the browser or a full page (cool super snappy UI) to capture it.
- 


CONTINUOUS SCROLL:
- basically, i just want the feature o xShare (the app for windows) that allows the user to define an area or the full screen and simulate mouse down scroll or down command to effectively scroll through the web page and, in the end, create a perfect screenshot of the full content of that area, in a perfect image file type to allow for ocr and interpretation of coordinates, etc.  

- it coula 

A Chrome extension that collects URLs from any webpage based on a pattern you specify by hovering over links.

## Features

- **Hover-based URL collection** - When enabled, captures URLs from hyperlinks as you hover over them
- **Pattern matching** - Only captures URLs containing your specified substring (case-insensitive)
- **Deduplication** - URLs are normalized (removing trailing slashes, default ports) to avoid duplicates
- **Real-time display** - See captured URLs immediately in the popup
- **Export** - Download all collected URLs as a text file

## Usage

1. Click the extension icon to open the popup
2. Enable the extension with the toggle
3. Enter a filter pattern (e.g., "github" or "pdf")
4. Browse any webpage and hover over links
5. Matching URLs are automatically collected
6. Click "Download" to export the list

## Technical Details

### URL Capture Mechanism - Efficiency & Latency

The hover-based capture flow works as follows:

```
mouseover event
    │
    ▼
Synchronous checks (instant, ~microseconds):
    - Is enabled? Is grepStr set?
    - Find closest <a> element
    - Already in hoveredLinks WeakSet?
    - Is valid http/https URL?
    - Does URL match pattern?
    - Already in processingUrls Set?
    │
    ▼
Async storage read (chrome.storage.local.get)  ← LATENCY HERE
    │
    ▼
Check if URL already in list
    │
    ▼
Async storage write (chrome.storage.local.set) ← LATENCY HERE
```

#### Latency Sources

**1. `chrome.storage.local` operations** - These are the bottleneck. Each hover that matches triggers:
- 1 async read to get the current list
- 1 async write to save the updated list

These involve IPC (inter-process communication) between the content script and Chrome's extension storage. Typical latency: **1-5ms per operation**.

**2. No batching** - Every qualifying hover does its own read/write cycle. If you rapidly hover over 10 matching links, that's 10 separate storage round-trips.

#### Safeguards in Place

| Mechanism | Purpose | Location |
|-----------|---------|----------|
| `hoveredLinks` (WeakSet) | Prevents re-processing the same link element while still hovering | content.js:60 |
| `processingUrls` (Set) | Prevents race conditions for the same URL | content.js:62, 89-94 |
| Early returns | Skips work quickly if disabled/no match | content.js:67-79 |

#### Practical Impact

- **You won't notice latency** during normal browsing - the capture is fire-and-forget
- **Rapid hovering** over many matching links could queue up storage operations, but Chrome handles this gracefully
- **The UI updates in real-time** because the popup listens to `chrome.storage.onChanged`

#### Known Inefficiency

The main inefficiency isn't latency you'd feel - it's that the design reads the entire URL list from storage on every hover to check for duplicates, rather than maintaining an in-memory Set. For hundreds of collected URLs, this becomes wasteful.

## File Structure

```
├── manifest.json    # Extension configuration (Manifest V3)
├── content.js       # Content script - hover detection & URL capture
├── popup.html       # Extension popup UI
├── popup.js         # Popup logic - settings & list management
└── icons/           # Extension icons
```

## Permissions

- `storage` - Save settings and URL list
- `downloads` - Export URLs to file
- `<all_urls>` - Run content script on all pages
