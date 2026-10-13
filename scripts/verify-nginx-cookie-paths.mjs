import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = path.join(repositoryRoot, "docker/nginx/default.conf.template");
const hostTemplatePath = path.join(repositoryRoot, "ops/nginx/dochub.conf.template");
const template = await readFile(templatePath, "utf8");
const hostTemplate = await readFile(hostTemplatePath, "utf8");
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
assert.match(
  rendered,
  /frame-src 'self';/,
  "web page CSP must allow same-origin preview content",
);
assert.match(rendered, /frame-ancestors 'none';/, "web page CSP must remain non-embeddable");
assert.match(
  hostTemplate,
  /location ~ \^\/api\/\(preview\|drive-preview\)\/\[\^\/\]\+\/content\$/,
  "host Nginx must have a route-specific preview location",
);
assert.match(hostTemplate, /proxy_hide_header X-Frame-Options;/, "host Nginx must not forward DENY for preview content");
assert.doesNotMatch(
  hostTemplate.match(/location ~ \^\/api\/\(preview\|drive-preview\)[\s\S]*?\n  }/)?.[0] ?? "",
  /add_header X-Frame-Options/,
  "host Nginx preview location must not restore X-Frame-Options: DENY",
);

console.log("Nginx preview/OAuth cookie rewrites and preview framing policy are present in the production templates.");
