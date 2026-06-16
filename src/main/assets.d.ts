// electron-vite ?asset 导入：构建期把资源拷到输出目录，运行期解析为绝对路径
declare module '*?asset' {
  const src: string
  export default src
}
