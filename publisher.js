require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const ROOT = __dirname;

const API_KEY = process.env.ROBLOX_OPEN_CLOUD_API_KEY;

const PLACES_PATH = path.join(ROOT, 'places.json');
const GAMES_PATH = path.join(ROOT, 'games.json');
const PUBLISH_RESULTS_PATH = path.join(ROOT, 'publish-results.json');

const TEMPLATE_PATH = path.join(ROOT, 'files', 'template.rbxlx');
const OUTPUT_DIR = path.join(ROOT, 'out');

const SERVER_SCRIPT_PATH = path.join(ROOT, 'serverScript.lua');
const MODULE_PATH = path.join(ROOT, 'module', 'module.rbxm');

const MODULE_ASSET_NAME = process.env.MODULE_ASSET_NAME || 'YetiMainModule';
const MODULE_ASSET_DESCRIPTION =
  process.env.MODULE_ASSET_DESCRIPTION || 'Uploaded by Yeti Open Cloud Publisher';

// Important safety delays.
// Asset IDs can exist before Roblox live servers can require them reliably.
const WAIT_AFTER_ALL_ASSETS_MS = Number(process.env.WAIT_AFTER_ALL_ASSETS_MS || 180000);
const WAIT_BETWEEN_ASSET_UPLOADS_MS = Number(process.env.WAIT_BETWEEN_ASSET_UPLOADS_MS || 3000);
const WAIT_BETWEEN_PUBLISHES_MS = Number(process.env.WAIT_BETWEEN_PUBLISHES_MS || 10000);

function must(value, name) {
  if (!value) {
    throw new Error(`Missing ${name}. Add it to Railway variables or .env.`);
  }

  return value;
}

function cloudHeaders(extra = {}) {
  return {
    'x-api-key': must(API_KEY, 'ROBLOX_OPEN_CLOUD_API_KEY'),
    ...extra
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeNameForLink(name) {
  return (
    String(name || 'Game')
      .trim()
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'Game'
  );
}

function extractPlaceIdFromLink(link) {
  const match = String(link || '').match(/roblox\.com\/games\/(\d+)/i);
  return match ? match[1] : null;
}

function extractNameFromLink(link) {
  const raw = String(link || '')
    .split('/games/')[1]
    ?.split('/')[1]
    ?.split('?')[0]
    ?.split('#')[0];

  if (!raw) return null;

  try {
    return decodeURIComponent(raw).replace(/-/g, ' ');
  } catch {
    return raw.replace(/-/g, ' ');
  }
}

function ensureFilesExist() {
  must(API_KEY, 'ROBLOX_OPEN_CLOUD_API_KEY');

  if (!fs.existsSync(PLACES_PATH)) {
    throw new Error('Missing places.json');
  }

  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error('Missing files/template.rbxlx');
  }

  if (!fs.existsSync(SERVER_SCRIPT_PATH)) {
    throw new Error('Missing serverScript.lua');
  }

  if (!fs.existsSync(MODULE_PATH)) {
    throw new Error('Missing module/module.rbxm');
  }

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function creatorContext() {
  const userId = (process.env.CREATOR_USER_ID || '').trim();
  const groupId = (process.env.CREATOR_GROUP_ID || '').trim();

  if (groupId && userId) {
    throw new Error('Use either CREATOR_USER_ID or CREATOR_GROUP_ID, not both.');
  }

  if (groupId) {
    return {
      creator: {
        groupId: Number(groupId)
      }
    };
  }

  if (userId) {
    return {
      creator: {
        userId: Number(userId)
      }
    };
  }

  throw new Error(
    'Set CREATOR_USER_ID or CREATOR_GROUP_ID in Railway variables / .env for asset uploads.'
  );
}

async function getUniverseIdFromPlaceId(placeId) {
  const url = `https://apis.roblox.com/universes/v1/places/${placeId}/universe`;

  const res = await axios.get(url, {
    headers: cloudHeaders(),
    validateStatus: (status) => status >= 200 && status < 500,
    timeout: 15000
  });

  if (res.status >= 400) {
    throw new Error(
      `Failed to get universeId for placeId=${placeId}. HTTP ${res.status}: ${JSON.stringify(res.data)}`
    );
  }

  const universeId = res.data?.universeId;

  if (!universeId) {
    throw new Error(`No universeId returned for placeId=${placeId}: ${JSON.stringify(res.data)}`);
  }

  return String(universeId);
}

async function normalizeAndFillPlaces(places) {
  const fixed = [];

  for (let i = 0; i < places.length; i++) {
    const original = places[i];
    const place = { ...original };

    if (!place.placeId) {
      const fromLink = extractPlaceIdFromLink(place.link);
      if (fromLink) {
        place.placeId = fromLink;
      }
    }

    if (!place.placeId || String(place.placeId).includes('PUT_')) {
      throw new Error(`places.json item ${i + 1} is missing placeId.`);
    }

    if (!place.name) {
      place.name = extractNameFromLink(place.link) || `Game-${i + 1}`;
    }

    if (!place.channel) {
      place.channel = 1;
    }

    if (!place.link || String(place.link).includes('PUT_PLACE_ID_HERE')) {
      place.link = `https://www.roblox.com/games/${place.placeId}/${safeNameForLink(place.name)}`;
    }

    if (!place.universeId || String(place.universeId).includes('PUT_')) {
      console.log(`[Publisher] Getting universeId for ${place.name} placeId=${place.placeId}...`);
      place.universeId = await getUniverseIdFromPlaceId(place.placeId);
      console.log(`[Publisher] ${place.name} universeId=${place.universeId}`);
      await sleep(500);
    }

    fixed.push({
      channel: Number(place.channel || 1),
      name: String(place.name),
      placeId: String(place.placeId),
      universeId: String(place.universeId),
      link: String(place.link)
    });
  }

  writeJson(PLACES_PATH, fixed);
  console.log('[Publisher] Updated places.json with filled universeIds.');

  return fixed;
}

function operationUrlFromPath(operationPath) {
  if (!operationPath) return null;

  if (/^https?:\/\//i.test(operationPath)) {
    return operationPath;
  }

  return `https://apis.roblox.com/assets/v1/${operationPath.replace(/^\/+/, '')}`;
}

async function pollOperation(operationPath) {
  const url = operationUrlFromPath(operationPath);

  if (!url) {
    throw new Error('Assets API did not return an operation path.');
  }

  for (let i = 1; i <= 60; i++) {
    const res = await axios.get(url, {
      headers: cloudHeaders(),
      validateStatus: (status) => status >= 200 && status < 500,
      timeout: 15000
    });

    if (res.status >= 400) {
      throw new Error(`Operation poll failed HTTP ${res.status}: ${JSON.stringify(res.data)}`);
    }

    const op = res.data;

    if (op.done) {
      if (op.error) {
        throw new Error(`Asset operation failed: ${JSON.stringify(op.error)}`);
      }

      const assetId =
        op.response?.assetId ||
        op.response?.asset?.assetId ||
        op.response?.id ||
        op.response?.asset?.id;

      if (!assetId) {
        throw new Error(`Asset operation done but no assetId found: ${JSON.stringify(op)}`);
      }

      return String(assetId);
    }

    console.log(`[Publisher] Waiting for asset upload operation ${i}/60...`);
    await sleep(2000);
  }

  throw new Error('Timed out waiting for asset upload operation.');
}

function getModuleContentType() {
  const ext = path.extname(MODULE_PATH).toLowerCase();

  if (ext === '.rbxm') return 'model/x-rbxm';
  if (ext === '.rbxmx') return 'model/x-rbxmx';

  return 'model/x-rbxm';
}

async function uploadModuleAssetForPlace(place, index) {
  const placeName = safeNameForLink(place.name || `Game-${index + 1}`);
  const uniqueName = `${MODULE_ASSET_NAME}-${placeName}-${Date.now()}-${index + 1}`;

  console.log(
    `[Publisher] Uploading module asset ${index + 1} for ${place.name || place.placeId}...`
  );

  const request = {
    assetType: 'Model',
    displayName: uniqueName,
    description: `${MODULE_ASSET_DESCRIPTION} | placeId=${place.placeId}`,
    creationContext: creatorContext()
  };

  const form = new FormData();

  form.append('request', JSON.stringify(request), {
    contentType: 'application/json'
  });

  form.append('fileContent', fs.createReadStream(MODULE_PATH), {
    filename: path.basename(MODULE_PATH),
    contentType: getModuleContentType()
  });

  const res = await axios.post('https://apis.roblox.com/assets/v1/assets', form, {
    headers: cloudHeaders(form.getHeaders()),
    validateStatus: (status) => status >= 200 && status < 500,
    maxBodyLength: Infinity,
    timeout: 60000
  });

  if (res.status >= 400) {
    throw new Error(`Asset upload failed HTTP ${res.status}: ${JSON.stringify(res.data)}`);
  }

  const immediateAssetId =
    res.data?.response?.assetId ||
    res.data?.response?.asset?.assetId ||
    res.data?.assetId ||
    res.data?.asset?.assetId;

  if (immediateAssetId) {
    console.log(
      `[Publisher] Asset uploaded immediately for ${place.name || place.placeId}. assetId=${immediateAssetId}`
    );
    return String(immediateAssetId);
  }

  const operationPath = res.data?.path || res.data?.operationPath || res.data?.name;

  const assetId = await pollOperation(operationPath);

  console.log(
    `[Publisher] Asset upload finished for ${place.name || place.placeId}. assetId=${assetId}`
  );

  return String(assetId);
}

async function uploadAllModuleAssetsFirst(places) {
  console.log('');
  console.log('[Publisher] ===== STEP 1: Uploading all module assets first =====');

  const assetMap = [];

  for (let i = 0; i < places.length; i++) {
    const place = places[i];

    const assetId = await uploadModuleAssetForPlace(place, i);

    assetMap.push({
      index: i,
      channel: Number(place.channel || 1),
      name: place.name || `Game-${i + 1}`,
      placeId: String(place.placeId),
      universeId: String(place.universeId),
      link: getPlaceLink(place),
      moduleAssetId: String(assetId)
    });

    console.log(
      `[Publisher] Saved module asset for ${place.name || place.placeId}: ${assetId}`
    );

    await sleep(WAIT_BETWEEN_ASSET_UPLOADS_MS);
  }

  writeJson(PUBLISH_RESULTS_PATH, assetMap);
  console.log('[Publisher] All module assets created and saved to publish-results.json.');

  return assetMap;
}

function buildServerScriptSource(assetId) {
  const lua = fs.readFileSync(SERVER_SCRIPT_PATH, 'utf8');

  if (!lua.includes('ASSET_ID_HERE')) {
    console.warn('[Publisher] Warning: serverScript.lua does not contain ASSET_ID_HERE.');
  }

  return lua.replace(/ASSET_ID_HERE/g, String(assetId));
}

function serverScriptXml(luaSource) {
  const safeLua = luaSource.replace(/\]\]>/g, ']]]]><![CDATA[>');

  return `
    <Item class="Script" referent="YetiOpenCloudLoader">
      <Properties>
        <BinaryString name="AttributesSerialize"></BinaryString>
        <bool name="Disabled">false</bool>
        <Content name="LinkedSource"><null></null></Content>
        <string name="Name">YetiLoader</string>
        <ProtectedString name="Source"><![CDATA[${safeLua}]]></ProtectedString>
        <string name="Tags"></string>
      </Properties>
    </Item>`;
}

function replaceExistingLoader(xml, newScriptXml) {
  const existing =
    /\s*<Item class="Script" referent="YetiOpenCloudLoader">[\s\S]*?<\/Item>/m;

  if (existing.test(xml)) {
    return xml.replace(existing, newScriptXml);
  }

  return null;
}

function insertIntoServerScriptService(xml, newScriptXml) {
  const replaced = replaceExistingLoader(xml, newScriptXml);

  if (replaced) {
    return replaced;
  }

  const startMatch = /<Item class="ServerScriptService"[^>]*>/i.exec(xml);

  if (!startMatch) {
    throw new Error(
      'Could not find ServerScriptService in template.rbxlx. Open template in Studio and make sure ServerScriptService exists, then save as .rbxlx.'
    );
  }

  const startIndex = startMatch.index;
  const tagRe = /<\/?Item\b[^>]*>/gi;

  tagRe.lastIndex = startIndex;

  let depth = 0;
  let match;

  while ((match = tagRe.exec(xml))) {
    const tag = match[0];

    if (/^<Item\b/i.test(tag)) {
      depth += 1;
    } else if (/^<\/Item>/i.test(tag)) {
      depth -= 1;
    }

    if (depth === 0) {
      const closeIndex = match.index;
      return xml.slice(0, closeIndex) + newScriptXml + '\n' + xml.slice(closeIndex);
    }
  }

  throw new Error('Could not find end of ServerScriptService item in template.rbxlx.');
}

function patchTemplate(assetId, place) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

  let patched;

  if (template.includes('ASSET_ID_HERE')) {
    patched = template.replace(/ASSET_ID_HERE/g, String(assetId));
  } else {
    const lua = buildServerScriptSource(assetId);
    patched = insertIntoServerScriptService(template, serverScriptXml(lua));
  }

  verifyPatchedTemplate(patched, assetId, place);

  const outPath = path.join(OUTPUT_DIR, `${place.placeId}.rbxlx`);

  fs.writeFileSync(outPath, patched, 'utf8');

  return outPath;
}

function verifyPatchedTemplate(patchedText, assetId, place) {
  if (patchedText.includes('ASSET_ID_HERE')) {
    throw new Error(
      `Patch failed for ${place.name || place.placeId}: ASSET_ID_HERE is still inside the patched template.`
    );
  }

  if (!patchedText.includes(String(assetId))) {
    throw new Error(
      `Patch failed for ${place.name || place.placeId}: module assetId ${assetId} was not found in the patched template.`
    );
  }

  if (!patchedText.includes('YetiLoader') && !patchedText.includes('MODULE_ID')) {
    console.warn(
      `[Publisher] Warning for ${place.name || place.placeId}: patched file does not clearly show YetiLoader/MODULE_ID.`
    );
  }

  console.log(
    `[Publisher] Verified patched template for ${place.name || place.placeId}: moduleAssetId=${assetId}`
  );
}

async function publishPlace(place, rbxlxPath) {
  console.log(
    `[Publisher] Publishing ${place.name || place.placeId} to placeId=${place.placeId}, universeId=${place.universeId}...`
  );

  const url = `https://apis.roblox.com/universes/v1/${place.universeId}/places/${place.placeId}/versions?versionType=Published`;
  const file = fs.readFileSync(rbxlxPath);

  const maxAttempts = 6;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await axios.post(url, file, {
        headers: cloudHeaders({
          'Content-Type': 'application/xml'
        }),
        validateStatus: (status) => status >= 200 && status < 500,
        maxBodyLength: Infinity,
        timeout: 120000
      });

      if (res.status >= 200 && res.status < 300) {
        console.log(
          `[Publisher] Published place ${place.placeId}. Response: ${JSON.stringify(res.data)}`
        );

        return res.data;
      }

      const body = JSON.stringify(res.data || {});
      const lowerBody = body.toLowerCase();

      const isRetryable =
        res.status === 409 ||
        res.status === 429 ||
        res.status === 500 ||
        res.status === 502 ||
        res.status === 503 ||
        res.status === 504 ||
        lowerBody.includes('server is busy') ||
        lowerBody.includes('try again');

      console.log(
        `[Publisher] Publish attempt ${attempt}/${maxAttempts} failed HTTP ${res.status}: ${body}`
      );

      if (!isRetryable || attempt === maxAttempts) {
        throw new Error(`Place publish failed HTTP ${res.status}: ${body}`);
      }
    } catch (err) {
      const msg = err?.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;

      const lowerMsg = String(msg).toLowerCase();

      const isRetryable =
        lowerMsg.includes('server is busy') ||
        lowerMsg.includes('try again') ||
        lowerMsg.includes('timeout') ||
        lowerMsg.includes('econnreset');

      console.log(`[Publisher] Publish attempt ${attempt}/${maxAttempts} error: ${msg}`);

      if (!isRetryable || attempt === maxAttempts) {
        throw err;
      }
    }

    const waitMs = attempt * 30000;

    console.log(
      `[Publisher] Roblox is busy. Waiting ${Math.round(waitMs / 1000)}s before retry...`
    );

    await sleep(waitMs);
  }

  throw new Error('Place publish failed after all retry attempts.');
}

async function updatePlaceName(place) {
  if (!place.name || String(place.name).includes('PUT_')) {
    return false;
  }

  const endpoints = [
    {
      method: 'patch',
      url: `https://apis.roblox.com/cloud/v2/universes/${place.universeId}/places/${place.placeId}`,
      body: {
        displayName: place.name
      }
    },
    {
      method: 'patch',
      url: `https://apis.roblox.com/cloud/v2/universes/${place.universeId}/places/${place.placeId}`,
      body: {
        name: place.name
      }
    }
  ];

  for (const endpoint of endpoints) {
    try {
      const res = await axios({
        method: endpoint.method,
        url: endpoint.url,
        data: endpoint.body,
        headers: cloudHeaders({
          'Content-Type': 'application/json'
        }),
        validateStatus: (status) => status >= 200 && status < 500,
        timeout: 15000
      });

      if (res.status >= 200 && res.status < 300) {
        console.log(`[Publisher] Updated place name to "${place.name}".`);
        return true;
      }

      console.log(`[Publisher] Place rename attempt HTTP ${res.status}: ${JSON.stringify(res.data)}`);
    } catch (err) {
      console.log(`[Publisher] Place rename attempt failed: ${err?.response?.status || err.message}`);
    }
  }

  console.log('[Publisher] Rename skipped/failed. Publishing still succeeded, so continuing.');

  return false;
}

function getPlaceLink(place) {
  if (place.link && !String(place.link).includes('PUT_PLACE_ID_HERE')) {
    return place.link;
  }

  return `https://www.roblox.com/games/${place.placeId}/${safeNameForLink(place.name)}`;
}

function writeGamesJson(places) {
  const games = places.map((place) => {
    return {
      channel: Number(place.channel || 1),
      link: getPlaceLink(place)
    };
  });

  writeJson(GAMES_PATH, games);

  console.log(`[Publisher] Wrote ${games.length} links to games.json.`);
}

function validatePlaces(places) {
  if (!Array.isArray(places)) {
    throw new Error('places.json must be an array.');
  }

  if (!places.length) {
    throw new Error('places.json is empty.');
  }
}

async function publishAll() {
  ensureFilesExist();

  const rawPlaces = readJson(PLACES_PATH);
  validatePlaces(rawPlaces);

  const places = await normalizeAndFillPlaces(rawPlaces);

  const assetMap = await uploadAllModuleAssetsFirst(places);

  console.log('');
  console.log(
    `[Publisher] Waiting ${Math.round(WAIT_AFTER_ALL_ASSETS_MS / 1000)}s so Roblox can process all uploaded module assets...`
  );
  await sleep(WAIT_AFTER_ALL_ASSETS_MS);

  console.log('');
  console.log('[Publisher] ===== STEP 2: Patching and publishing all places =====');

  const results = [];

  for (let i = 0; i < places.length; i++) {
    const place = places[i];
    const assetInfo = assetMap[i];

    console.log('');
    console.log(
      `[Publisher] Publishing game ${i + 1}/${places.length}: ${place.name || place.placeId} with moduleAssetId=${assetInfo.moduleAssetId}`
    );

    const patchedPath = patchTemplate(assetInfo.moduleAssetId, place);

    await publishPlace(place, patchedPath);

    await updatePlaceName(place);

    results.push({
      channel: Number(place.channel || 1),
      name: place.name || `Game-${i + 1}`,
      placeId: String(place.placeId),
      universeId: String(place.universeId),
      link: getPlaceLink(place),
      moduleAssetId: String(assetInfo.moduleAssetId)
    });

    writeJson(PUBLISH_RESULTS_PATH, results);

    await sleep(WAIT_BETWEEN_PUBLISHES_MS);
  }

  writeGamesJson(places);
  writeJson(PUBLISH_RESULTS_PATH, results);

  console.log(`[Publisher] Wrote detailed results to publish-results.json.`);

  return {
    placesPublished: places.length,
    results
  };
}

if (require.main === module) {
  publishAll()
    .then((result) => {
      console.log(`[Publisher] Done. placesPublished=${result.placesPublished}`);

      for (const item of result.results) {
        console.log(
          `[Publisher] ${item.name} | placeId=${item.placeId} | moduleAssetId=${item.moduleAssetId}`
        );
      }
    })
    .catch((err) => {
      console.error('[Publisher] FAILED:', err.message);
      process.exit(1);
    });
}

module.exports = {
  publishAll
};