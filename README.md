# Cell ROI Analyzer

包含两个页面：

1. **AI 自动分区识别**：上传图片、选择 4×/10×/20× 物镜和细胞形态、画 ROI、切网格，使用尺度感知的本地图像处理计算小圆细胞或铺展贴壁细胞，并支持手动修正和结果导出。
2. **手动采样外推分析**：不同颜色代表不同密度区域，支持自由画笔、开放线保留、端点补画连接、闭合后高亮、按颜色外推并汇总细胞数量与铺展面积。

## 当前版本更新

- 明场/相差图默认使用多尺度 DoG/LoG 式圆形 blob 检测，再通过 Hessian 各向同性、径向“亮中心—暗环—背景恢复”校验和非极大值抑制，排除圆孔边缘、细长结构和纹理，并确保每个小圆细胞只计数一次。
- 新增“自动（按倍镜推荐）/ 小圆细胞 / 铺展贴壁细胞”选择。自动模式在 4× 推荐圆点模式，在 10×/20× 推荐铺展模式，也可手动覆盖。
- 铺展模式使用多尺度暗胞体响应定位候选中心，通过同一胞体盆地聚类避免长细胞重复计数，再用径向边缘覆盖率和局部纹理排除培养皿边界；轮廓受强边缘和相邻细胞中心约束。
- AI 页面支持 4×、10×、20× 物镜预设：圆细胞预计直径约 12、30、60 px，铺展细胞预计短轴约 22、55、110 px。
- 荧光图继续使用局部背景校正、Otsu 自动阈值、形态学清理、颗粒分析与接触细胞分离。
- 可调整背景半径、阈值偏移、最小/最大细胞面积，并可关闭接触细胞分离。
- 每个网格使用带缓冲区的图像分析，再按完整细胞质心唯一归属分区，降低跨网格重复计数。
- 分区图像只在浏览器本地处理，不需要 OpenAI API key，也不会发送给外部视觉模型。
- AI 分区和手动采样均支持 `.tif` / `.tiff` 文件。
- TIFF/TIF 默认在浏览器中使用随站点部署的 UTIF.js 解码，不依赖服务器系统程序，也不会上传原始 TIFF。

## 原有手动采样能力

- 手动采样页面中，细胞轮廓开放线的两端如果接触到**另一个已高亮细胞的边界**，系统会尝试用“手绘线 + 该细胞边界的一段”自动融合成新的封闭区域，并自动高亮、计算面积。
- 继续保留开放线：没有闭合的线不会消失，可以后续从端点附近继续补画连接。
- 支持上传 `.tif` / `.tiff` 文件。浏览器不能直接显示的 TIFF 会通过本地后端尝试转换成 PNG 显示。

## 运行

```bash
cd cell_analyzer_web_boundary_v7
cp .env.example .env
npm start
```

然后打开：

```text
http://localhost:8787
```

## .env 路径

`.env` 放在项目根目录：

```text
cell_analyzer_web_boundary_v7/.env
```

示例：

```env
OPENAI_API_KEY=你的新API_KEY
OPENAI_MODEL=gpt-5.5
USE_MOCK=false
PORT=8787
```

当前浏览器界面不需要 API key。服务端保留了旧版 `/api/analyze` 接口用于兼容，但默认界面不会调用它。

## TIFF 说明

`.tif/.tiff` 默认由浏览器本地解码并转换为画布图像，支持常见黑白、灰度、RGB、LZW、PackBits、Deflate、JPEG 等 TIFF 类型。原始 TIFF 不会发送到服务器。

如果浏览器解码失败，程序才会调用兼容接口 `/api/convert-tiff`，并按以下顺序尝试：

1. Python + Pillow；
2. macOS 自带 `sips`；
3. ImageMagick 的 `magick` / `convert`。

如果三种方式都不可用，可以先用 ImageJ/Fiji/NIS-Elements 将显微镜原始 TIFF 导出为 PNG 再上传。

## 自动识别参数建议

- **物镜倍数**：必须与采集图像使用的物镜一致。`1_RGB_DIA.tif` 的元数据为 Nikon Plan Fluor 4×，`11_RGB_DIA.tif` 为 Nikon Plan Fluor 10×。
- **AI 识别对象**：悬浮、未贴壁的小圆点选择“小圆细胞 / 圆点”；纺锤形、多边形或相互接触的贴壁细胞选择“铺展贴壁细胞”。
- **阈值偏移**：正值更严格、减少低置信度目标；负值更宽松、保留较淡目标。
- **最小/最大细胞面积**：单位为 px²；4× 默认最小面积 40 px²，以保留直径约 8 px 的小圆细胞。
- **背景校正半径 / 分水岭**：主要用于荧光颗粒分割；明场模式由倍镜决定圆点直径或铺展细胞短轴尺度。

## 方法依据

- LoG/尺度空间适合定位近圆形 blob；TrackMate 等生物图像工具也采用 LoG 检测器。
- 明场细胞自动分析研究使用背景校正、候选目标检测和基于形态的粘连目标分离；当前铺展模式据此采用中心种子、边缘证据与邻近中心约束。
- CellProfiler 将尺寸、形状筛选和接触目标分离作为可靠的细胞识别策略。
- 通用深度模型（如 Cellpose）能力强，但针对特殊明场成像仍需要代表性人工标注来验证或微调；当前版本没有足够标注集，因此优先采用可解释、可在浏览器离线运行的确定性方案。

参考论文：

- [An automatic method for robust and fast cell detection in bright field images from high-throughput microscopy](https://pubmed.ncbi.nlm.nih.gov/24090363/)
- [CellProfiler: image analysis software for identifying and quantifying cell phenotypes](https://pmc.ncbi.nlm.nih.gov/articles/PMC1794559/)
- [Cellpose: a generalist algorithm for cellular segmentation](https://www.nature.com/articles/s41592-020-01018-x)
- [Comparing Deep Learning Performance for CLL Cell Segmentation in Brightfield Microscopy Images](https://pubmed.ncbi.nlm.nih.gov/39246684/)


## v9 更新

- 手动采样页面中，细胞开放线的首尾如果接触到同一个小样本区域边界，会自动使用“手绘线 + 小样本边界的一段”融合为闭合高亮区域。
- 画布默认不显示未闭合、G1、S1、C1 等文字标签，避免遮挡视野。编号和对象信息仍保留在右侧对象表中。
- 导出的标注图/轮廓图也不叠加文字标签，只显示线条和高亮区域。
- 保留 TIFF/TIF 导入支持。


## v9 更新

- 细胞画线首尾可以分别接触不同边界自动闭合，例如一端接触小样本区域边界，另一端接触已有细胞边界；系统会在两个边界本身相接/足够接近时自动融合成封闭区域。
- 保持画布无文字标签，避免遮挡视线。
