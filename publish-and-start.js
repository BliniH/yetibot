require('dotenv').config();

async function main() {
  const shouldPublish = String(process.env.AUTO_PUBLISH_ON_START || '').toLowerCase() === 'true';

  if (shouldPublish) {
    const { publishAll } = require('./publisher');
    console.log('[Bootstrap] AUTO_PUBLISH_ON_START=true, publishing places before starting Discord bot...');
    await publishAll();
    console.log('[Bootstrap] Publish finished. Starting Discord bot...');
  } else {
    console.log('[Bootstrap] AUTO_PUBLISH_ON_START is not true. Starting Discord bot without publishing.');
  }

  try {
    require('./index.js');
  } catch (err) {
    console.error('[Bootstrap] Could not start index.js. Put your current working Discord bot file in this folder as index.js.');
    console.error(err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[Bootstrap] FAILED:', err.message);
  process.exit(1);
});
