import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {Library,run} from "../src/library.mjs";
import {encodeArgs,parseQuality} from "../src/quality.mjs";
import {createVideoPilotServer} from "../src/server.mjs";

test("quality parsing accepts UI settings and rejects unsupported values", () => {
  assert.equal(parseQuality("1080p"),1080);
  assert.equal(parseQuality(360),360);
  for(const value of [0,480,1440,"../../etc/passwd",null]) assert.throws(()=>parseQuality(value));
});

test("real FFmpeg qualities encode HD and reduce bytes while preserving variant seek routes", async t => {
  try {await run("ffmpeg",["-version"]);} catch {t.skip("FFmpeg is not installed");return;}
  const dataDir=await mkdtemp(path.join(tmpdir(),"vp-real-quality-"));
  const library=await new Library({dataDir}).init();
  const video={id:"00000000-0000-4000-8000-000000000003",state:"ready",quality:1080,mediaQuality:1080,duration:3};
  library.videos.push(video);
  const input=path.join(dataDir,"source.mp4");
  await run("ffmpeg",["-y","-v","error","-f","lavfi","-i","testsrc2=size=1920x1080:rate=30","-f","lavfi","-i","sine=frequency=440:sample_rate=44100",
    "-t","3","-c:v","libx264","-threads","2","-preset","ultrafast","-c:a","aac",input]);
  const master=library.paths(video.id);
  await run("ffmpeg",encodeArgs(input,master.media,1080));
  await library.buildSeekIndex(video,master);
  for(const quality of [720,360]) {
    await library.requestQuality(video.id,quality);
    await library.variantJobs.get(`${video.id}:${quality}`).promise;
    assert.equal((await library.qualityStatus(video.id,quality)).ready,true);
    const info=JSON.parse((await run("ffprobe",["-v","error","-select_streams","v:0","-show_entries","stream=width,height","-of","json",library.paths(video.id,quality).media])).stdout);
    assert.equal(info.streams[0].height,quality);
  }
  const sizes=await Promise.all([360,720,1080].map(q=>stat(library.paths(video.id,q).media).then(info=>info.size)));
  assert.ok(sizes[0]<sizes[1] && sizes[1]<sizes[2],`quality sizes: ${sizes}`);
  const host=createVideoPilotServer({library,webRoot:dataDir,port:0});
  await host.start();t.after(()=>host.stop());
  const origin=`http://127.0.0.1:${host.server.address().port}`;
  const response=await fetch(`${origin}/api/stream/${video.id}.ts?quality=360&seek=1`);
  assert.equal(response.status,200);
  assert.equal(response.headers.get("x-video-duration"),"3");
  assert.ok(Number(response.headers.get("x-video-seek-time"))<=1);
  assert.ok((await response.arrayBuffer()).byteLength<=sizes[0]);
  const absent=await fetch(`${origin}/api/stream/${video.id}.ts?quality=540`);
  assert.equal(absent.status,409);
  const invalid=await fetch(`${origin}/api/stream/${video.id}.ts?quality=1440`);
  assert.equal(invalid.status,400);
});
