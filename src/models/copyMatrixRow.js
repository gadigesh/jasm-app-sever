const mongoose = require("mongoose");

const CopyMatrixRowSchema = new mongoose.Schema(
	{
		copyMatrixId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "CopyMatrix",
			required: true,
			index: true,
		},
		rowIndex: {
			type: Number,
			required: true,
		},
		rowData: {
			type: mongoose.Schema.Types.Mixed,
			required: true,
		},
	},
	{ timestamps: true }
);

CopyMatrixRowSchema.index({ copyMatrixId: 1, rowIndex: 1 }, { unique: true });

module.exports =
	mongoose.models.CopyMatrixRow ||
	mongoose.model("CopyMatrixRow", CopyMatrixRowSchema);
