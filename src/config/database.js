const mongoose = require("mongoose");
require("dotenv").config();
const seedAssetTemplates = require("../seeders/assetTemplate");

const connectDB = async () => {
	try {
		await mongoose.connect(
			`${process.env.MONGO_URI}/${process.env.DB_NAME}`
		);
		console.log("MongoDB connected");
		await seedAssetTemplates();
	} catch (error) {
		console.error("MongoDB connection failed:", error.message);
		process.exit(1);
	}
};

module.exports = connectDB;
