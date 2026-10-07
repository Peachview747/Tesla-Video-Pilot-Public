`h264-60fps.mp4` is a synthetic two-second fixture generated with FFmpeg's
`testsrc2` and `sine` filters, AVC video at 320 × 180 and 60 fps, and AAC audio.
The native converter check compiles the production worker and checks frame
rate reduction, all output qualities, combined and separate audio, MPEG-TS
packet alignment, codec decoding, software fallback, and cancellation.

Generate it with:

```sh
ffmpeg -f lavfi -i testsrc2=size=320x180:rate=60 \
  -f lavfi -i sine=frequency=440:sample_rate=44100 -t 2 \
  -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p \
  -c:a aac -b:a 64k -movflags +faststart h264-60fps.mp4
```
