import express from 'express'
import { clearSession, getAllData, getSessionHistory, queryChatBot } from "../controllers/dataController.js"

const dataRouter = express.Router();

dataRouter.route("/news").get(getAllData);
dataRouter.route("/query/chatbot").post(queryChatBot);
dataRouter.route("/session/history").get(getSessionHistory);
dataRouter.route("/session/clear-history").get(clearSession);

export default dataRouter;