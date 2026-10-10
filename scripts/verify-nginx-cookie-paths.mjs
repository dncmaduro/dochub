import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = path.join(repositoryRoot, "docker/nginx/default.conf.template");
const template = await readFile(templatePath, "utf8");
const rendered = template
  .replaceAll("${WEB_HOST}", "dochub.example.test")
  .replaceAll("${NGINX_CLIENT_MAX_BODY_SIZE}", "16m");

assert.doesNotMatch(rendered, /\$\{[^}]+\}/, "production Nginx template did not render all application variables");
assert.match(
  rendered,
  /proxy_cookie_path ~\^\/auth\(\?<dochub_auth_path>\/\.\*\)\?\$ \/api\/auth\$dochub_auth_path;/,
  "Google/application auth cookie rewrite is missing",
);
assert.match(
  rendered,
  /proxy_cookie_path \/drive\/integration\/callback \/api\/drive\/integration\/callback;/,
  "Google Drive OAuth callback cookie rewrite is missing",
);
assert.match(
  rendered,
  /proxy_cookie_path ~\^\/preview\(\?<dochub_preview_path>\/\.\*\)\?\$ \/api\/preview\$dochub_preview_path;/,
  "legacy preview cookie rewrite is missing",
);
assert.match(
  rendered,
  /proxy_cookie_path ~\^\/drive-preview\(\?<dochub_drive_preview_path>\/\.\*\)\?\$ \/api\/drive-preview\$dochub_drive_preview_path;/,
  "Drive preview cookie rewrite is missing",
);
assert.match(rendered, /proxy_pass http:\/\/api:3000\//, "production API gateway must strip the public /api prefix");

console.log("Nginx preview and OAuth cookie-path rewrites are present in the rendered production template.");
