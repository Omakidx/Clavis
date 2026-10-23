import { readdirSync, readFileSync } from 'node:fs';

/**
 * Linux only: the memory of a browser process tree, read from /proc. PSS (proportional set size)
 * counts shared pages once, so summing it over the tree gives the browser's real footprint, which
 * the JS heap alone (a few MB for the reader) does not: canvases, the PDF.js worker and Skia caches
 * are native memory. The tree is found by the unique `--user-data-dir` the test launched with, so
 * other browsers on the machine (other test runs, the developer's own Chrome) are never counted.
 */
export interface TreeMemory {
  totalMB: number;
  rendererMB: number;
  gpuMB: number;
  browserMB: number;
  processes: number;
}

export function treeMemory(userDataDir: string): TreeMemory {
  const all = new Map<number, { cmd: string; ppid: number }>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmd = readFileSync(`/proc/${name}/cmdline`, 'utf8');
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      all.set(Number(name), { cmd, ppid });
    } catch {
      // The process exited while we were reading: not part of a stable measurement.
    }
  }
  const mine = new Set<number>(
    [...all]
      .filter(([, p]) => p.cmd.includes(`--user-data-dir=${userDataDir}`))
      .map(([pid]) => pid),
  );
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, p] of all) {
      if (!mine.has(pid) && mine.has(p.ppid)) {
        mine.add(pid);
        grew = true;
      }
    }
  }
  const out: TreeMemory = { totalMB: 0, rendererMB: 0, gpuMB: 0, browserMB: 0, processes: 0 };
  for (const pid of mine) {
    let pssKb: number;
    try {
      pssKb = Number(
        /Pss:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))?.[1] ?? 0,
      );
    } catch {
      continue;
    }
    const type = /--type=([a-z-]+)/.exec(all.get(pid)?.cmd ?? '')?.[1] ?? 'browser';
    const mb = pssKb / 1024;
    out.totalMB += mb;
    out.processes++;
    if (type === 'renderer') out.rendererMB += mb;
    else if (type === 'gpu-process') out.gpuMB += mb;
    else if (type === 'browser') out.browserMB += mb;
  }
  return out;
}
