const express = require('express');
const router = express.Router();

router.use('/', require('./image'));
router.use('/', require('./llm'));
router.use('/', require('./video'));
router.use('/', require('./audio'));
router.use('/', require('./runninghub'));

module.exports = router;
