const AssetTemplate = require("../models/assetTemplate");
const { ASSET_TEMPLATE_IDS } = require("../constants/assetTemplate");

const seedAssetTemplates = async () => {
	const templates = [
		{
			id: "prospecting",
			title: "Prospecting",
			desc: "Standard row-column structure optimized for Google Sheets and Excel exports.",
			icon: "FileSpreadsheet",
			iconColor: "text-yellow-600",
			iconBg: "bg-yellow-100",
		},
		{
			id: "ecommerce",
			title: "E-commerce",
			desc: "Designed for product feeds including SKU, pricing, variants, and image galleries.",
			icon: "ShoppingBag",
			iconColor: "text-red-600",
			iconBg: "bg-red-100",
		},
		{
			id: "social",
			title: "Social",
			desc: "Templates for ad creatives, copy variations, targeting parameters, and CTA links.",
			icon: "UserCog",
			iconColor: "text-green-600",
			iconBg: "bg-purple-100",
		},
		{
			id: "custom",
			title: "Custom",
			desc: "Structure for subject lines, pre-headers, body copy, and dynamic fields.",
			icon: "Settings",
			iconColor: "text-purple-600",
			iconBg: "bg-purple-100",
		},
	];

	for (const template of templates) {
		await AssetTemplate.updateOne(
			{ id: template.id },
			{ $set: template },
			{ upsert: true }
		);
	}

	console.log("✅ Asset Templates seeded");
};

module.exports = seedAssetTemplates;
