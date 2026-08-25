---
"worktree-kit": patch
---

Fixed the multi-worktree progress spinner (used by `wt update` and `wt remove`) duplicating a status line many times instead of redrawing it in place, whenever that line was wide enough to wrap across more than one terminal row (e.g. a long branch name in a narrow terminal). The repaint previously rewound the cursor by a fixed count of logical lines while each wrapped line advanced an extra physical row, so every 80ms tick under-rewound by one row and left an uncleared copy behind - the duplicates accumulated as siblings finished. The renderer now tracks the previous frame's real physical height (accounting for line-wrapping) and clears with a single erase-to-end-of-display on each repaint, matching the geometry clack's own single-line spinner already uses.
