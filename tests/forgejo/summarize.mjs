import {readFile} from 'node:fs/promises';

const [operationsPath, containersPath] = process.argv.slice(2);
if (!operationsPath || !containersPath) {
  console.error('Usage: node tests/forgejo/summarize.mjs <load.jsonl> <containers.jsonl>');
  process.exit(2);
}

async function readLines(path) {
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

const [operations, snapshots] = await Promise.all([readLines(operationsPath), readLines(containersPath)]);
const percentile = (values, p) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * p) - 1] ?? null;
};

const bytesPerUnit = {B: 1, KiB: 2 ** 10, MiB: 2 ** 20, GiB: 2 ** 30};
function residentMiB(usage) {
  const match = /^([\d.]+)(B|KiB|MiB|GiB) /.exec(usage);
  return match ? Math.round(Number(match[1]) * bytesPerUnit[match[2]] / 2 ** 20) : null;
}

for (const phase of operations) {
  const start = Date.parse(phase.startedAt);
  const end = Date.parse(phase.finishedAt);
  const samples = snapshots.filter(sample => {
    const time = Date.parse(sample.time);
    return time >= start && time <= end;
  });
  const services = Object.groupBy(samples, ({container}) =>
    container.Name.match(/-(control-db|postgres|forgejo)-\d+$/)?.[1] ?? container.Name);
  const containers = Object.fromEntries(Object.entries(services).map(([service, entries]) => {
    const cpu = entries.map(({container}) => parseFloat(container.CPUPerc));
    const memory = entries.map(({container}) => residentMiB(container.MemUsage))
      .filter(value => value !== null);
    return [service, {samples: cpu.length, cpuP95Percent: percentile(cpu, 0.95),
      cpuPeakPercent: percentile(cpu, 1), memoryPeakMiB: percentile(memory, 1)}];
  }));
  console.log(JSON.stringify({...phase, containers}));
}
