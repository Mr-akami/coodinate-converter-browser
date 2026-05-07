import type { Hono } from 'hono';

export interface DevFaultConfig {
  enabled: boolean;
  forced404: Set<string>;
}

/*
 * Dev-only routes that toggle artificial fault injection on the proj-data
 * surface (e.g. forcing a grid file to return 404). Disabled in production
 * via NODE_ENV.
 *
 *   POST /__dev/grid-404/:name      enable
 *   DELETE /__dev/grid-404/:name    disable
 *   GET /__dev/grid-404             list active
 */
export function registerDevFaultRoutes(app: Hono, cfg: DevFaultConfig): void {
  if (!cfg.enabled) return;

  app.post('/__dev/grid-404/:name', (c) => {
    const name = decodeURIComponent(c.req.param('name'));
    cfg.forced404.add(name);
    return c.json({ ok: true, forced404: [...cfg.forced404] });
  });

  app.delete('/__dev/grid-404/:name', (c) => {
    const name = decodeURIComponent(c.req.param('name'));
    cfg.forced404.delete(name);
    return c.json({ ok: true, forced404: [...cfg.forced404] });
  });

  app.delete('/__dev/grid-404', (c) => {
    cfg.forced404.clear();
    return c.json({ ok: true, forced404: [] });
  });

  app.get('/__dev/grid-404', (c) => {
    return c.json({ enabled: cfg.enabled, forced404: [...cfg.forced404] });
  });
}
