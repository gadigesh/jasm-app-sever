const mongoose = require("mongoose");
const { ASSET_TEMPLATE_IDS } = require("../constants/assetTemplate");

const assetTemplateSchema = new mongoose.Schema(
	{
		id: {
			type: String,
			required: true,
			unique: true,
			enum: Object.values(ASSET_TEMPLATE_IDS),
		},
		title: {
			type: String,
			required: true,
			trim: true,
		},
		desc: {
			type: String,
			trim: true,
		},
		icon: {
			type: String,
			required: true,
		},
		iconColor: {
			type: String,
			required: true,
		},
		iconBg: {
			type: String,
			required: true,
		},
		isActive: {
			type: Boolean,
			default: true,
		},
	},
	{
		timestamps: true,
		versionKey: false,
	}
);

module.exports = mongoose.model("AssetTemplate", assetTemplateSchema);
