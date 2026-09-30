/**
 * Question bank routes — mounted at `/api/question-banks`.
 *
 * `categories` and `export` are static segments declared before `/:id`.
 * CSV/XLSX import uses the `import` Multer category (spreadsheet MIME types).
 */

const express = require('express');
const controller = require('../controllers/questionBank.controller');
const { authenticate, resolveOrganization } = require('../middleware/auth.middleware');
const { requireAuthor, requireStaff } = require('../middleware/role.middleware');
const { uploadLimiter } = require('../middleware/rateLimit.middleware');
const { upload } = require('../config/multer');

const router = express.Router();

const author = [authenticate, resolveOrganization, requireAuthor()];
const staff = [authenticate, resolveOrganization, requireStaff()];

router.get('/', ...staff, controller.list);
router.get('/accessible', ...staff, controller.accessible);
router.get('/export', ...staff, controller.exportQuestions);

router.get('/categories/list', ...staff, controller.listCategories);
router.post('/categories', ...author, controller.createCategory);
router.patch('/categories/:categoryId', ...author, controller.updateCategory);
router.delete('/categories/:categoryId', ...author, controller.deleteCategory);

router.post('/', ...author, controller.create);

router.get('/:id', ...staff, controller.getOne);
router.patch('/:id', ...author, controller.update);
router.delete('/:id', ...author, controller.destroy);
router.post('/:id/recount', ...author, controller.recount);
router.get('/:id/insights', ...staff, controller.insights);
router.get('/:id/duplicates', ...staff, controller.duplicates);
router.post('/:id/share', ...author, controller.share);
router.delete('/:id/share', ...author, controller.revokeShare);
router.post('/:id/import', uploadLimiter, ...author, upload('import').single('file'), controller.importQuestions);

module.exports = router;
