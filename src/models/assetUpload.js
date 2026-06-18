const mongoose = require("mongoose");

const AssetUploadSchema = new mongoose.Schema(
	{
		// 🔗 LINK TO DASHBOARD CARD (Parent)
		accountId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "Account",
			required: true, // Every upload MUST belong to an account
			index: true,
		},

		// Display Name for the UI List (e.g. "Summer Campaign")
		assetName: {
			type: String,
			trim: true,
			required: true,
		},
		fileName: {
			type: String,
			required: true,
		},
		originalName: String,
		inputType: {
			type: String,
			enum: ["file", "gsheet"],
			default: "file",
		},
		fileType: {
			type: String,
			enum: ["csv", "xlsx", "GSheet"],
		},
		uniqueColumn: {
			type: String,
			required: true,
		},
		fileRef: {
			type: String,
			required: true,
		},
		storageType: {
			type: String,
			enum: ["local", "s3"],
			default: "local",
		},
		fileHash: {
			type: String,
			required: false,
		},
		copyMatrixId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "CopyMatrix",
			default: null,
		},
		columns: [String],

		// Status can now be 'partial_success' or 'draft'
		status: {
			type: String,
			enum: [
				"draft",
				"pending",
				"processing",
				"completed",
				"failed",
				"partial_success",
			],
			default: "pending",
		},

		processedRows: {
			type: Number,
			default: 0,
		},
		message: String,
		errorLog: String, // For system errors (crashes)

		// 🆕 DETAILED VALIDATION REPORT
		validationErrors: [
			{
				row: Number,
				message: String,
				data: mongoose.Schema.Types.Mixed,
			},
		],

		uploadedBy: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "User",
		},
	},
	{ timestamps: true }
);

module.exports =
	mongoose.models.AssetUpload ||
	mongoose.model("AssetUpload", AssetUploadSchema);
