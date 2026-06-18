// Change this to 's3' in your .env file later
const STORAGE_TYPE = process.env.STORAGE_TYPE || "local";

const localStorage = require("./local");
const s3Storage = require("./s3");

// Export the strategy based on config
module.exports = STORAGE_TYPE === "s3" ? s3Storage : localStorage;
