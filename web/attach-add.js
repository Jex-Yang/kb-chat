/**
 * attach-add.js — 附件准备（草稿输入框与“修改消息”共用）
 * 文档解析走 /api/files/parse（服务端精确 token），图片生成 dataURL + 缩略图。
 */
import { api } from './api.js';
import {
  TEXT_EXTS, extOf, isImageFile, makeImageVariants, readAsDataUrl, uid,
} from './util.js';

const MAX_TEXT_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function isDuplicateAttachment(list, file) {
  return (list || []).some(
    (a) => a.name === file.name && Number(a.size) === Number(file.size),
  );
}

export async function prepareAttachment(file, id = uid('att')) {
  if (!file || !file.name) throw new Error('文件无效');
  if (file.name === '.DS_Store' || file.name.startsWith('._')) {
    throw new Error(`忽略隐藏文件：${file.name}`);
  }

  if (isImageFile(file)) {
    if (file.size > MAX_IMAGE_BYTES) {
      throw new Error(`图片过大（上限 8MB）：${file.name}`);
    }
    const dataUrl = await readAsDataUrl(file);
    let thumb = null;
    let preview = null;
    try {
      const variants = await makeImageVariants(dataUrl);
      thumb = variants.thumb;
      preview = variants.preview;
    } catch { /* 缩略图/预览图失败不阻塞发送 */ }
    return {
      id, name: file.name, kind: 'image', ext: extOf(file.name),
      size: file.size, tokens: null, dataUrl, thumb, preview,
      status: 'ready',
    };
  }

  if (!TEXT_EXTS.includes(extOf(file.name))) {
    throw new Error(`不支持的附件类型：${file.name}（${TEXT_EXTS.join(' / ')} 或图片）`);
  }
  if (file.size > MAX_TEXT_BYTES) {
    throw new Error(`文件过大（上限 20MB）：${file.name}`);
  }
  const res = await api.parseFile(file);
  return {
    id, name: res.name || file.name, kind: 'text',
    ext: res.ext || extOf(file.name), size: file.size,
    text: res.text || '', tokens: Number(res.tokens) || 0,
    truncated: !!res.truncated, status: 'ready',
  };
}

