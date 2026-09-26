/**
 * A look at the panel, for the eyes only.
 *
 * Not a test, and not run by the suite: it opens the panel of a running container
 * with the session the end to end suite leaves behind, chooses a viewport preset,
 * and writes a screenshot. It is what to reach for while working on the panel,
 * where the acceptance is visual and the suite's assertions are about behaviour:
 *
 *   E2E_BASE_URL=http://127.0.0.1:3032 SHOT=panel.png node scripts/panel-shot.mjs
 *
 * PRESET picks the size to apply, by its `widthxheight` value (default 1920x1080).
 * The container must be one the suite has run against, so that
 * `../lib/state.mjs` holds a session that signs in; start one with
 * start-container.sh, then run the suite once.
 */

import { chromium } from "@playwright/test";
import { STORAGE_STATE } from "../lib/state.mjs";
