# Smart Tab Manager

A powerful Chrome extension to automatically group your tabs by domain, subdomain, or fuzzy keywords.

## To-Do List
- [ ] Implement robust "Open All" and "Close All" folders functionality (Logic is partially implemented in `grouping.js` under `forceMode`, but triggers are currently commented out in `popup.js` and `popup.html`).
- [ ] Refine Folder Mode transition animations.
- [ ] Add custom color mapping for specific domains.

## Features
- **Auto-grouping**: Organizations tabs as you browse.
- **Folder Mode**: Collapses non-active tab groups to save space.
- **Custom Ordering**: Alphabetical, Manual, or Active-First.
- **Fuzzy Matching**: Uses Fuse.js for intelligent keyword grouping.
