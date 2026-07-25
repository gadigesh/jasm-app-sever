const mongoose = require("mongoose");

const CopyMatrixSchema = new mongoose.Schema(
	{
		accountId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "Account",
			required: true,
			index: true,
		},
		name: {
			type: String,
			trim: true,
			required: true,
		},
		fileName: String,
		inputType: {
			type: String,
			enum: ["file", "gsheet"],
			default: "file",
		},
		fileType: {
			type: String,
			enum: ["csv", "xlsx", "GSheet"],
		},
		fileRef: String,
		sheetGid: Number,
		fileHash: String,
		columns: [String],
		status: {
			type: String,
			enum: [
				"draft",
				"pending",
				"processing",
				"completed",
				"failed",
				"partial_success",
				"Active",
				"Inactive",
			],
			default: "pending",
		},
		processedRows: {
			type: Number,
			default: 0,
		},
		message: String,
		errorLog: String,
		validationErrors: [
			{
				row: Number,
				message: String,
				data: mongoose.Schema.Types.Mixed,
			},
		],
		updatedBy: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "User",
		},
		assetUploadId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "AssetUpload",
			default: null,
		},
		lastDeletedAssetSourceName: {
			type: String,
			trim: true,
			default: null,
		},
		deletedAssetSourceNames: {
			type: [String],
			default: [],
		},
		/** Preferred unique column for AS creation (e.g. "column1"). */
		uniqueColumn: {
			type: String,
			trim: true,
			default: null,
		},
		/** True after Back/Cancel from a completed edit — resume prompt on next Edit. */
		hasEditDraft: {
			type: Boolean,
			default: false,
			index: true,
		},
	},
	{ timestamps: true }
);

module.exports =
	mongoose.models.CopyMatrix ||
	mongoose.model("CopyMatrix", CopyMatrixSchema);
