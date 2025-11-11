const express = require("express");
const { protect } = require("../middleware/authMiddleware");
const {
  accessChat,
  fetchChats,
  sendMessage,
  getMessages,
} = require("../controllers/chatController");

const router = express.Router();

router.post("/", protect, accessChat);
router.get("/", protect, fetchChats);
router.post("/message", protect, sendMessage);
router.get("/:chatId/messages", protect, getMessages);

module.exports = router;
