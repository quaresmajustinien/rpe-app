const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');

const defaultData = {
  users: [],
  sessions: [],
  responses: [],
  excelMapping: {}
};

function load() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultData, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

module.exports = { load, save };
