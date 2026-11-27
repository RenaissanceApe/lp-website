/* Entry point of the form front door. Only the default export lives here: Workers
 * read named exports of the main module as entry points. The logic is in intake.mjs
 * (requests, cron) and logic.mjs (pure rules); _docs/FORM_FRONT_DOOR.md explains it.
 */
import { handlePost, runScheduled, redirect } from './intake.mjs';

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'POST') return handlePost(request, env, ctx);
    // A GET (someone opened the address) goes to the home page.
    return redirect(env, '/');
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },
};
