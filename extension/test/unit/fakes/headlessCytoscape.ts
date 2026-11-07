// jsdom has no 2d canvas, so jsdom tests run the real canvas code on headless Cytoscape:
// `vi.mock('cytoscape', async (o) => (await import('../fakes/headlessCytoscape')).headlessCytoscape(o))`.
export async function headlessCytoscape(importOriginal: () => Promise<unknown>) {
  const real = ((await importOriginal()) as { default: (options: object) => unknown }).default;
  return { default: () => real({ headless: true, styleEnabled: false }) };
}
