const multer = require('multer');
const path = require('path');
const fs = require('fs');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const LOGOS_DIR = path.join(__dirname, '..', '..', 'uploads', 'logos');
const SIGNATURES_DIR = path.join(__dirname, '..', '..', 'uploads', 'signatures');
ensureDir(LOGOS_DIR);
ensureDir(SIGNATURES_DIR);

function makeStorage(subfolder) {
  const dir = ensureDir(path.join(__dirname, '..', '..', 'uploads', subfolder));
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, dir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    }
  });
}

// IMPORTANT: logo and signature must NOT share one multer instance with a
// single fixed destination — establishmentAssets.fields([{name:'logo'},
// {name:'signature'}]) previously saved BOTH files into uploads/logos/
// regardless of field name, while the PDF generator looks for the
// signature under uploads/signatures/, so the file was never found and the
// signature silently failed to render. Routing by fieldname fixes that.
const MAX_LOGO_SIGNATURE_SIZE = 5 * 1024 * 1024; // 5 MB
const establishmentAssets = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, file.fieldname === 'signature' ? SIGNATURES_DIR : LOGOS_DIR);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    }
  }),
  limits: { fileSize: MAX_LOGO_SIGNATURE_SIZE }
});
const excelImport = multer({ storage: makeStorage('imports') });

module.exports = { establishmentAssets, excelImport, MAX_LOGO_SIGNATURE_SIZE };
