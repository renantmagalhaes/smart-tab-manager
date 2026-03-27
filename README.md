# Smart Tab Manager

A powerful Chrome extension to automatically group your tabs by domain, subdomain, or fuzzy keywords.

## Project Structure

`manifest.json` stays at the repository root because Chrome requires it for unpacked extensions.

```text
.
├── assets/
│   └── icons/           # Extension icons referenced by the manifest
├── docs/
│   └── privacy-policy.md
├── src/
│   ├── background/      # Service worker entrypoint and tab grouping logic
│   ├── popup/           # Popup HTML, styles, and controller script
│   └── shared/
│       └── vendor/      # Third-party runtime dependencies checked into the repo
├── LICENSE
├── README.md
└── manifest.json
```

## To-Do List
- [ ] Implement robust "Open All" and "Close All" folders functionality (Logic is partially implemented in `src/background/grouping.js` under `forceMode`, but triggers are currently commented out in `src/popup/index.js` and `src/popup/index.html`).
- [ ] Refine Folder Mode transition animations.
- [ ] Add custom color mapping for specific domains.

## Features
- **Auto-grouping**: Organizations tabs as you browse.
- **Folder Mode**: Collapses non-active tab groups to save space.
- **Custom Ordering**: Alphabetical, Manual, or Active-First.
- **Fuzzy Matching**: Uses Fuse.js for intelligent keyword grouping.
