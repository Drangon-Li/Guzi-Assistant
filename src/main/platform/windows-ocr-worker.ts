import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import { existsSync } from 'fs'
import { join } from 'path'
import type { OcrDetectionResult } from './windows-ocr-result.ts'

process.once('disconnect', () => process.exit(0))

async function main(): Promise<void> {
  const [imagePath, modelDirectory, runtimePackage] = process.argv.slice(2)
  if (!imagePath || !modelDirectory || !runtimePackage) throw new Error('本地 OCR 启动参数无效')
  const models = {
    detectionPath: join(modelDirectory, 'ch_PP-OCRv4_det_infer.onnx'),
    recognitionPath: join(modelDirectory, 'ch_PP-OCRv4_rec_infer.onnx'),
    dictionaryPath: join(modelDirectory, 'ppocr_keys_v1.txt')
  }
  if (!Object.values(models).every(existsSync)) throw new Error('本地 OCR 模型缺失，请重新安装谷子助手')
  const runtimeRequire = createRequire(runtimePackage)
  const { default: Ocr } = await import(pathToFileURL(runtimeRequire.resolve('@gutenye/ocr-node')).href) as {
    default: { create(options: unknown): Promise<{ detect(image: { data: Buffer; width: number; height: number }): Promise<OcrDetectionResult> }> }
  }
  const sharp = runtimeRequire('sharp')
  const metadata: { width: number; height: number } = await sharp(imagePath).metadata()
  // Guten otherwise adds contain-padding while rounding to 32, shifting normalized screenshot boxes.
  const prepared: { data: Buffer; info: { width: number; height: number } } = await sharp(imagePath)
    .resize({ width: Math.ceil(metadata.width / 32) * 32, height: Math.ceil(metadata.height / 32) * 32, fit: 'fill' })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const ocr = await Ocr.create({ models, onnxOptions: {
    executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1
  } })
  const result = await ocr.detect({ data: prepared.data, width: prepared.info.width, height: prepared.info.height })
  process.send?.({ result })
}

void main().catch((error: unknown) => {
  process.send?.({ error: error instanceof Error ? error.message : '本地 OCR 识别失败' })
})
