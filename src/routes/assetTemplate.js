const express = require("express");
const assetRouter = express.Router();
const AssetTemplate = require("../models/assetTemplate");
const { userAuth } = require("../middlewares/auth");

// GET all active templates
assetRouter.get("/asset-sources/templates", userAuth, async (req, res) => {
	try {
		const templates = await AssetTemplate.find({ isActive: true })
			.sort({ createdAt: 1 })
			.lean();

		res.json(templates);
	} catch (err) {
		res.status(500).json({ message: err.message });
	}
});

module.exports = assetRouter;
