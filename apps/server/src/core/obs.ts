import type { Logger, ObsActions } from "@saarathi/shared";

/**
 * OBS seam. The obs-websocket-js adapter lands in Phase 2 behind this same
 * interface; until then dev machines and headless runs get this one, so a
 * module can call `ctx.obs` without checking whether OBS exists.
 */
export function nullObs(log: Logger): ObsActions {
  return {
    connected: false,
    async setScene(name) {
      log.info(`obs (not connected): would switch to scene "${name}"`);
    },
    async setSourceVisible(scene, source, visible) {
      log.info(`obs (not connected): would ${visible ? "show" : "hide"} ${scene}/${source}`);
    },
  };
}
