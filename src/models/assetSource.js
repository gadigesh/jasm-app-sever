const mongoose = require("mongoose");

const AssetSourceSchema = new mongoose.Schema(
	{
		uploadId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "AssetUpload",
			required: true,
		},
		// ⚡ GENERIC INDEX FIELD
		// We copy the value of the unique column here (e.g. "SKU_123")
		// This makes updates fast without knowing the column name beforehand.
		primaryKey: {
			type: String,
			required: true,
			index: true,
		},
		// 👇 This allows ANY columns from the CSV to be saved
		rowData: {
			type: mongoose.Schema.Types.Mixed,
		},
		fileHash: {
			type: String,
			index: true,
		}, // Tracks which file version this row belongs to
		isDeleted: {
			type: Boolean,
			default: false,
			index: true,
		}, // Hides it from UI

		importStatus: {
			type: String,
			enum: ["DRAFT", "ACTIVE"],
			default: "DRAFT",
		},
		cmRowIndex: {
			type: Number,
			index: true,
		},
	},
	{
		timestamps: true, // gives createdAt & updatedAt
	}
);

// Composite Index: Ensure IDs are unique *within* a specific upload
AssetSourceSchema.index({ uploadId: 1, primaryKey: 1 }, { unique: true });

module.exports = mongoose.model("AssetSource", AssetSourceSchema);
