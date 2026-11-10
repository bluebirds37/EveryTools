/**
 * 运动传感器核心（FR-LIF-01/02）—— 纯函数部分：低通滤波、姿态角换算、气泡位移
 * wx 传感器生命周期由页面调用，本模块不直接触碰 wx。
 */

/** 通用低通滤波：y = αx + (1−α)y_prev；alpha 越小越平滑（响应约 1/alpha 帧） */
function lowPass(prev, next, alpha) {
  const a = Math.max(0.01, Math.min(1, alpha))
  return a * next + (1 - a) * prev
}

/** 角度低通：处理 359°→1° 的跨零跳变（取最短弧插值） */
function lowPassAngle(prev, next, alpha) {
  let diff = ((next - prev) % 360 + 540) % 360 - 180
  return ((prev + diff * Math.max(0.01, Math.min(1, alpha))) % 360 + 360) % 360
}

/**
 * 指南针平滑 + 校准判定：
 * accuracy 非 high 或长时间静止无变化时返回 needCalibration=true
 */
function compassState(prev, raw, accuracy) {
  const smooth = prev === null || prev === undefined ? raw : lowPassAngle(prev, raw, 0.25)
  const unreliable = accuracy && accuracy !== 'high'
  return { direction: smooth, unstable: !!unreliable, needCalibration: !!unreliable }
}

/**
 * 加速度计 → 倾角（度）。wx.onAccelerometerChange 返回 g 值（静止平放屏幕朝上 x≈0,y≈0,z≈1）。
 * pitch：屏幕上下倾（低头为正）；roll：左右倾（左高为正）。平放时均为 0。
 */
function pitchRollFromAccel(x, y, z) {
  const xx = Number(x) || 0, yy = Number(y) || 0, zz = Number(z) || 0
  const pitch = Math.atan2(-yy, Math.sqrt(xx * xx + zz * zz)) * 180 / Math.PI
  const roll = Math.atan2(xx, Math.sqrt(yy * yy + zz * zz)) * 180 / Math.PI
  return { pitch: pitch, roll: roll }
}

/** 气泡位移：角度映射为容器中心偏移（度→比例坐标 -1..1，maxDeg 对应容器边缘） */
function bubbleOffset(pitch, roll, maxDeg) {
  const mx = Math.max(1, maxDeg || 15)
  return {
    x: clamp(roll / mx, -1, 1),
    y: clamp(pitch / mx, -1, 1)
  }
}

/** 水平判定：|pitch| 与 |roll|（按所选轴）均小于阈值 → 锁定 */
function isLevel(pitch, roll, axis, thresholdDeg) {
  const th = thresholdDeg || 0.5
  if (axis === 'pitch') return Math.abs(pitch) <= th
  if (axis === 'roll') return Math.abs(roll) <= th
  return Math.abs(pitch) <= th && Math.abs(roll) <= th
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v
}

/** 8 方位名 */
const DIR_NAMES = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']
function dirName(deg) {
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8
  return DIR_NAMES[idx]
}

module.exports = {
  lowPass: lowPass,
  lowPassAngle: lowPassAngle,
  compassState: compassState,
  pitchRollFromAccel: pitchRollFromAccel,
  bubbleOffset: bubbleOffset,
  isLevel: isLevel,
  dirName: dirName,
  clamp: clamp
}
