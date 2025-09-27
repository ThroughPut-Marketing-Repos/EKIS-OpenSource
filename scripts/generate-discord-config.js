#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Load .env if present
dotenv.config();

const CONFIG_PATH = path.resolve(process.cwd(), 'config.json');

const readJsonFile = (filePath) => {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Failed to read ${filePath}: ${e.message}`);
    process.exit(1);
  }
};

const writeJsonFile = (filePath, data) => {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  } catch (e) {
    console.error(`Failed to write ${filePath}: ${e.message}`);
    process.exit(1);
  }
};

const deepMerge = (target, source) => {
  const out = { ...target };
  for (const key of Object.keys(source || {})) {
    const t = out[key];
    const s = source[key];
    if (s && typeof s === 'object' && !Array.isArray(s) && t && typeof t === 'object' && !Array.isArray(t)) {
      out[key] = deepMerge(t, s);
    } else if (s !== undefined) {
      out[key] = s;
    }
  }
  return out;
};

const token = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN || '';
const applicationId = process.env.DISCORD_APPLICATION_ID || process.env.DISCORD_CLIENT_ID || '';
const guildId = process.env.DISCORD_GUILD_ID || '';
const enabledEnv = process.env.DISCORD_ENABLED;
const enabled = typeof enabledEnv !== 'undefined' ? String(enabledEnv).toLowerCase() === 'true' : undefined;
const commandPrefix = process.env.DISCORD_COMMAND_PREFIX;
const commandName = process.env.DISCORD_COMMAND_NAME;

if (!token) {
  console.error('No Discord token found in env (DISCORD_BOT_TOKEN or DISCORD_TOKEN). Aborting.');
  process.exit(1);
}

const existing = readJsonFile(CONFIG_PATH);

const discordBlock = {
  enabled: enabled !== undefined ? enabled : true,
  token,
  applicationId,
  guildId,
  commandPrefix: commandPrefix || (existing.discord?.commandPrefix || '!'),
  commandName: commandName || (existing.discord?.commandName || 'verify')
};

const updated = deepMerge(existing, { discord: discordBlock });

writeJsonFile(CONFIG_PATH, updated);

console.log('Discord configuration has been generated/updated in config.json');
