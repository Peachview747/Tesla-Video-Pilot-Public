# Tesla Video Pilot · Version 0.1.34 · Build 46

- **Full-screen gap removed.** The full-screen canvas filled the whole screen height with `object-fit: contain`
  pinned to the top, so on the Tesla display (taller than 16:9 once the browser bar is shown) every spare pixel
  became a black band between the picture and the floating controls. The player is now a centred column:
  video at its own aspect ratio, full width, with the control rail and timeline directly beneath it. Spare
  height is split above and below the group. On screens wider than the video, the picture is limited to
  `100dvh - 96px` so the rail always fits.
