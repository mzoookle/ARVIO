"use strict";
const backend = require("./_backend");
const coordinator = require("../../private-cloud/provider-coordinator");
exports.handler = (event) => coordinator.handle(event, backend);
