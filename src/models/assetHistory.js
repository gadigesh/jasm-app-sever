// models/assetHistory.js (Keep this Strict)
const mongoose = require("mongoose");

const AssetHistorySchema = new mongoose.Schema(
	{
		assetId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "AssetSource",
			required: true,
		},
		
		// ✅ Keep this required and linked to User
		updatedBy: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "User",
			required: true,
		},
		changes: [
			{
				field: String,
				oldValue: mongoose.Schema.Types.Mixed,
				newValue: mongoose.Schema.Types.Mixed,
			},
		],
	},
	{
		timestamps: true,
	}
);

module.exports = mongoose.model("AssetHistory", AssetHistorySchema);
