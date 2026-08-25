// electron-vite ?asset 导入：构建期把资源拷到输出目录，运行期解析为绝对路径
declare module '*?asset' {
  const src: string
  export default src
}

// Vite ?raw 导入：构建期把文件内容内联为字符串（native/*.m 的 Obj-C 源码走这里）
declare module '*.m?raw' {
  const src: string
  export default src
}
