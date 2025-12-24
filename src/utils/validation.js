const validater = require("validator");
const validateSignUpdata = (req) => {
	const { firstName, lastName, emailId } = req.body;
	if (!firstName) {
		throw new Error("Name is not Valid");
	}
	if (!validater.isEmail(emailId)) {
		throw new Error("Please enter valid email");
	}
};
module.exports = { validateSignUpdata };
