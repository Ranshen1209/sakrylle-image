# Theme switching

The Image implementation follows the snapshot lifecycle fixes in Sakrylle API's
`frontend/src/composables/useTheme.ts`, while retaining Image's stored theme preference.

- Prefer actual pointer coordinates; keyboard activation uses the visible control center.
- Set origin and radius as percentages before the first capture. Pixel animation
  coordinates can be mis-scaled by Chromium's high-DPI compositor.
- CSS owns `::view-transition-new(root)` animation. Do not attach filled WAAPI
  effects to `documentElement`; those can survive snapshot teardown.
- Serialize root snapshots. Ignore repeat clicks until the matching native
  `finished` promise settles, two animation frames pass, and 80 ms cooldown ends.
- A 2-second watchdog or rejected `ready` may request a skip and disable further
  native transitions for that page. Neither is allowed to release the lock.
- Keep the button state synchronized inside the actual theme update callback.
- Reduced motion and unsupported/failed native transitions use instant switching.

`src/lib/theme.test.ts` covers first capture, pointer/keyboard origins, click bursts,
cooldown, watchdog, native failures, cleanup and persisted preference. Browser
verification must inspect the first rendered snapshot after reload and check that
repeated click bursts leave zero animations and at most one live transition.
