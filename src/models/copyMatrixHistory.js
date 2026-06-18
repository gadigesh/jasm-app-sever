const mongoose = require("mongoose");

const CopyMatrixHistorySchema = new mongoose.Schema(
	{
		copyMatrixId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "CopyMatrix",
			required: true,
			index: true,
		},
		copyMatrixRowId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "CopyMatrixRow",
		},
		rowIndex: Number,
		action: {
			type: String,
			enum: ["row_edit", "finish", "sync"],
			default: "row_edit",
		},
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
	{ timestamps: true }
);

module.exports =
	mongoose.models.CopyMatrixHistory ||
	mongoose.model("CopyMatrixHistory", CopyMatrixHistorySchema);
