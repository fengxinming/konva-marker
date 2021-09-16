import { Stage, Layer, Arrow, Group } from 'konva';
import EventBus from 'emitter';
import { distanceBetween } from 'geometry';
import { LastSectionDashLine } from 'konva-extra';
import { on, off } from 'dom';
import {
  STATE_PENDING,
  STATE_DRAWING,
  ACTION_DRAW,
  ACTION_DRAG,
  ACTION_RECTIFY,
  addCircle,
  canDraw,
  displayConfirmation,
  displayGroup,
  displayCursorBalloon,
  isDone,
  toggleSelectedGroup,
  isCircle
} from '../_shared/el-common';
import { eachPoint } from '../_shared/util';
import {
  CATEGORY_POLY,
  CATEGORY_ARROW,
  valueEquals,
  ratio2px,
  transformValue
} from './shared';

// 初始化默认值
const defaultShapeConfig = {
  stroke: '#17C393', // 图形颜色
  strokeWidth: 2, // 图形粗细
  circleRadius: 5, // 边角圆圈的半径
  circleFill: '#FFFFFF', // 边角圆圈的填充色
  fill: 'rgba(23,195,147,0.2)', // 多边形区域填充
  hoveredFill: 'rgba(23,195,147,0.5)' // 多边形区域填充
};

export default class Container extends EventBus {
  initialize(stageOpts, opts = {}) {
    if (this.initialized) {
      return this;
    }

    this._props = {};

    const stage = new Stage(stageOpts);
    const layer = new Layer();
    stage.add(layer);

    // 内部状态控制
    resetInternalProps(this);

    // 外部传入控制
    this
      .set('value', [])
      .set('type', opts.type) // 自定义画图类型
      .set('drawable', opts.drawable) // 准备好开始画图
      .set('sides', opts.sides || 4) // 多边形限制几条边
      .set('groups', opts.groups || 2) // 限制画多少分组
      .set('decimals', opts.decimals) // 小数位
      .set('shapeConfig', opts.shapeConfig || {}) // 图形参数配置
      .set('defaultShapeConfig', opts.defaultShapeConfig || defaultShapeConfig); // 默认图形参数配置

    // 画图依赖
    this
      .set('stage', stage)
      .set('layer', layer)
      .set('panelEl', stageOpts.container)
      .set('cursorBalloonEl', opts.cursorBalloonEl)
      .set('confirmationEl', opts.confirmationEl);

    onDraw(this); // 监听画图
    onDrag(this); // 监听拖拽
    onRectify(this); // 监听调整大小
    onManipulate(this); // 监听鼠标操作
    return this;
  }

  /**
   * 销毁函数
   */
  destroy() {
    if (!this.initialized) {
      return this;
    }

    this.emit('beforeDestroy');

    this.get('stage').destroy();
    delete this._props;

    this.off('*');
    return this;
  }

  /**
   * 设置属性
   * @param {string} k
   * @param {any} v
   */
  set(k, v) {
    this._props[k] = v;
    return this;
  }

  /**
   * 获取属性
   * @param {string} k
   */
  get(k) {
    return this._props[k];
  }

  /**
   * 重新设置width, height
   * @param {number} width
   * @param {number} height
   */
  resize(width, height) {
    if (!this.initialized) {
      return false;
    }
    const stage = this.get('stage');
    const lastWidth = stage.width();
    const lastHeight = stage.height();

    if (width !== lastWidth || height !== lastHeight) {
      stage.width(width);
      stage.height(height);

      const ratioW = width / lastWidth;
      const ratioH = height / lastHeight;
      const value = this.get('value');
      const convertPoints = (n, j) => {
        return n * (j % 2 ? ratioH : ratioW);
      };

      return setValue(this, value.map((point) => {
        return {
          type: point.type,
          points: point.points.map(convertPoints),
          direction: point.direction.map(convertPoints)
        };
      }));
    }
    return false;
  }

  /**
   * 设置坐标
   *
   * @param {object[]} newValue
   * @returns {boolean} 是否设置了value
   */
  setValue(newValue) {
    if (!this.initialized || !newValue) {
      return false;
    }

    if (this.get('decimals')) {
      const stage = this.get('stage');
      newValue = ratio2px(newValue, stage.width(), stage.height());
    }
    else {
      newValue = newValue.slice(0); // 避免操作原始值
    }

    return setValue(this, newValue);
  }

  /**
   * 在界面上绘制图形
   */
  draw() {
    if (!this.initialized) {
      return this;
    }
    this.get('layer').batchDraw();
    return this;
  }

  /**
   * 删除选中的图形组
   */
  deleteSelectedGroup() {
    if (!this.initialized) {
      return this;
    }

    const selectedGroup = this.get('selectedGroup');
    if (selectedGroup) {
      const type = selectedGroup.name();

      selectedGroup.destroy();
      this.get('layer').batchDraw();

      displayConfirmation(this);

      const drews = this.get('state')
        ? this.get('drews')
        : this.get('drews') - 1;

      resetInternalProps(this)
        .set('drews', drews);

      // 转换 value
      const newValue = transformValue(
        this,
        updateValue(this, type), // 删除并更新 value
      );

      this.emit('delete', type, newValue, this);
      this.emit('change', newValue, this);
    }
    return this;
  }

  /**
   * 是否画完一套图形
   */
  isDone() {
    return isDone(this);
  }

  /**
   * 确定调整
   */
  resolveChanges() {
    resolveChanges(this, true);
  }

  /**
   * 取消调整
   */
  rejectChanges() {
    resolveChanges(this, false);
  }

  get initialized() {
    return !!this._props;
  }
}

/**
 * 监听画图
 * @param {Container} container
 */
function onDraw(container) {
  const stage = container.get('stage');
  const layer = container.get('layer');

  // 准备画图
  stage.on('mousedown', (evt) => {
    const { target } = evt;
    if (!canDraw(container, target)) {
      // 选中图组
      toggleSelectedGroup(container, target);
      return;
    }

    // 取消之前选中的图组
    toggleSelectedGroup(container, target);

    let category = container.get('category');
    // 默认先画矩形
    if (!category) {
      container.set('category', category = CATEGORY_POLY);
    }

    // 获取当前坐标
    let { x, y } = stage.getPointerPosition();
    x = Math.round(x);
    y = Math.round(y);

    const action = container.get('action');
    if (!action) {
      const type = container.get('type');
      // 当前图形配置
      const currentShapeConfig = type ? container.get('shapeConfig')[type] : container.get('defaultShapeConfig');

      // 画图前触发
      container.emit('beforeDraw', evt, container);

      container
        .set('state', STATE_DRAWING)
        .set('action', ACTION_DRAW);

      let group;
      let shape;

      checkCategory(category, () => {
        group = new Group({
          name: type
          // draggable: true,
        });

        // 暂存图形配置
        group.__shapeConfig = currentShapeConfig;

        // 初始化多边形
        const polyConfig = {
          name: category,
          stroke: currentShapeConfig.stroke,
          strokeWidth: currentShapeConfig.strokeWidth,
          points: [x, y]
        };
        if (currentShapeConfig.dash) {
          polyConfig.dash = currentShapeConfig.dash;
        }

        shape = new LastSectionDashLine(polyConfig);
      }, () => {
        group = container.get('prevShape').getParent();

        // 初始化箭头
        shape = new Arrow({
          name: category,
          stroke: currentShapeConfig.stroke,
          strokeWidth: currentShapeConfig.strokeWidth,
          points: [x, y],
          pointerAtBeginning: !!currentShapeConfig.pointerAtBeginning,
          fill: currentShapeConfig.stroke
          // pointerLength: 14,
          // pointerWidth: 16,
        });
      });

      container
        .set('step', 1)
        .set('currentPoints', [x, y])
        .set('currentShape', shape);

      group.add(shape);

      // 上环
      layer.add(
        addCircle(group, category, 0, currentShapeConfig, x, y, true, false)
      );
      layer.batchDraw();

      // 隐藏气泡
      displayCursorBalloon(container);
    }
    else {
      const sides = container.get('sides');
      const currentShape = container.get('currentShape');
      const currentPoints = container.get('currentPoints');
      const group = currentShape.getParent();
      const currentShapeConfig = group.__shapeConfig;

      // 画多边形到最后
      if (category === CATEGORY_POLY && currentPoints.length === sides * 2) {
        // 获取第一个多边形相关的环
        const firstCircle = group.findOne((node) => {
          return node.name() === CATEGORY_POLY
                && node.getClassName() === 'Circle'
                && node.__pointStart === 0;
        });
        const x2 = firstCircle.x();
        const y2 = firstCircle.y();

        // 第一个坐标点的方圆5像素内才算法闭合
        if (distanceBetween(x, y, x2, y2) <= 5) {
          container
            .set('state', STATE_PENDING)
            .set('selectedGroup', group);

          group.draggable(true);
          currentShape
            .points(currentPoints)
            .lastDashEnabled(false)
            .closed(true)
            .fill(currentShapeConfig.fill);

          group.__prePoints = currentPoints;

          group.getChildren((node) => {
            if (isCircle(node)) {
              node.draggable(true);
            }
          });

          layer.batchDraw();

          // 显示确认浮层
          displayConfirmation(container, currentPoints);

          // 画完一个多边形后确认提示
          container.emit('confirm');
        }
        return;
      }

      // 上环
      addCircle(
        group, category, currentPoints.length, currentShapeConfig, x, y, true, false
      );

      currentPoints.push(x, y);
      currentShape
        .points(currentPoints)
        .lastDashEnabled(false);
      layer.batchDraw();

      container.set('step', container.get('step') + 1);

      // 异常情况画箭头处理
      if (category !== CATEGORY_ARROW) {
        return;
      }

      // 距离小于5像素被认为是不合法操作
      if (distanceBetween(x, y, currentPoints[0], currentPoints[1]) < 5) {
        rejectDrewArrow(container);
        return;
      }

      group.__preDirection = currentPoints;

      container
        .set('state', STATE_PENDING);

      group.getChildren((node) => {
        if (isCircle(node)) {
          node.draggable(true);
        }
      });

      // 显示确认浮层
      displayConfirmation(container, group.__points);

      // 画完一个箭头后确认提示
      container.emit('confirm');
    }
  });

  // 用于处理画箭头完成
  stage.on('mouseup', () => {
    const category = container.get('category');
    // 不能画或者不是画箭头的时候不处理
    if (!(container.get('action') === ACTION_DRAW
        && container.get('state') === STATE_DRAWING
        && category === CATEGORY_ARROW)) {
      return;
    }

    let { x, y } = stage.getPointerPosition();
    x = Math.round(x);
    y = Math.round(y);

    const currentShape = container.get('currentShape');
    const currentPoints = container.get('currentPoints');

    // 距离小于5像素被认为是不合法操作
    if (distanceBetween(x, y, currentPoints[0], currentPoints[1]) < 5) {
      rejectDrewArrow(container);
      return;
    }

    const group = currentShape.getParent();
    const currentShapeConfig = group.__shapeConfig;

    // 上环
    addCircle(
      group, category, currentPoints.length, currentShapeConfig, x, y, true, true
    );

    currentPoints.push(x, y);
    currentShape.points(currentPoints);

    group.__preDirection = currentPoints;

    layer.batchDraw();

    container
      .set('state', STATE_PENDING);

    group.getChildren((node) => {
      if (isCircle(node)) {
        node.draggable(true);
      }
    });

    // 显示确认浮层
    displayConfirmation(container, group.__points);

    // 画完一个箭头后确认提示
    container.emit('confirm');
  });

  // 画图中
  stage.on('mousemove', () => {
    // 当正在画图时才触发
    if (!(container.get('action') === ACTION_DRAW
        && container.get('state') === STATE_DRAWING)) {
      return;
    }
    let { x, y } = stage.getPointerPosition();
    x = Math.round(x);
    y = Math.round(y);

    // 实时画图
    const currentShape = container.get('currentShape');
    const currentPoints = container.get('currentPoints');
    // 下次点击才记录点坐标
    currentShape.points(currentPoints.concat(x, y));
    if (currentShape.lastDashEnabled) {
      currentShape.lastDashEnabled(true);
    }
    layer.batchDraw();
  });

  return container;
}

/**
 * 监听图形拖拽
 * @param {Container} container
 */
function onDrag(container) {
  const layer = container.get('layer');

  // 拖动开始
  layer.on('dragstart', 'Group', (evt) => {
    const { currentTarget, target } = evt;
    const selectedGroup = container.get('selectedGroup');
    // 一定要在选中的时候才处理
    if (target !== selectedGroup // 事件冒泡会触发子元素
      || currentTarget !== selectedGroup) {
      return;
    }

    container.set('action', ACTION_DRAG);

    // 隐藏气泡
    displayCursorBalloon(container);
    // 隐藏确认浮层
    displayConfirmation(container);
  });

  // 拖动中
  layer.on('dragmove', 'Group', () => {
    // 隐藏气泡
    displayCursorBalloon(container);
  });

  // 拖动结束
  layer.on('dragend', 'Group', () => {
    // 一定要在拖拽了之后处理
    if (container.get('action') !== ACTION_DRAG) {
      return;
    }

    container.set('state', STATE_PENDING);

    const selectedGroup = container.get('selectedGroup');
    // 调整图形位置;
    const { x: offsetX, y: offsetY } = selectedGroup.absolutePosition();
    selectedGroup.absolutePosition({ x: 0, y: 0 });
    selectedGroup.getChildren((shape) => {
      if (shape.getClassName() === 'Circle') {
        const { x, y } = shape.absolutePosition();
        shape.absolutePosition({
          x: offsetX + x,
          y: offsetY + y
        });
      }
      else {
        const points = shape.points().map((p, j) => {
          return p + (j % 2 ? offsetY : offsetX);
        });
        shape
          .absolutePosition({ x: 0, y: 0 })
          .points(points);
      }
    });

    // 显示确认浮层
    displayConfirmation(container, selectedGroup.findOne('LastSectionDashLine').points());
    // 画完一个多边形后确认提示
    container.emit('confirm');
  });

  return container;
}

/**
 * 监听调整图形
 *
 * @param {Container} container
 */
function onRectify(container) {
  const layer = container.get('layer');

  // 开始调整大小
  layer.on('dragstart', 'Circle', (evt) => {
    container.set('action', ACTION_RECTIFY);

    const circle = evt.currentTarget;
    const { x, y } = circle.absolutePosition();
    circle.__dragStartX = x;
    circle.__dragStartY = y;

    let shape;
    const group = circle.getParent();
    checkCategory(circle.name(), () => { // 多边形
      shape = group.findOne('LastSectionDashLine');
    }, () => { // 方向
      shape = group.findOne('Arrow');
    });

    shape.__currentCircle = circle;

    container
      .set('currentShape', shape)
      .set('currentPoints', shape.points());

    // 隐藏气泡
    displayCursorBalloon(container);
    // 隐藏确认浮层
    displayConfirmation(container);
  });

  // 正在调整大小
  layer.on('dragmove', 'Circle', (evt) => {
    const circle = evt.currentTarget;
    const { x, y } = circle.absolutePosition();

    const pointStart = circle.__pointStart;
    const currentShape = container.get('currentShape');
    const points = container.get('currentPoints').slice(0);

    points[pointStart] += x - circle.__dragStartX;
    points[pointStart + 1] += y - circle.__dragStartY;
    currentShape.points(points);

    layer.batchDraw();
  });

  // 调整大小完成
  layer.on('dragend', 'Circle', (evt) => {
    const circle = evt.currentTarget;
    const selectedGroup = container.get('selectedGroup');

    container.set('state', STATE_PENDING);

    // 显示确认浮层
    displayConfirmation(container, selectedGroup.findOne('LastSectionDashLine').points());

    delete circle.__dragStartX;
    delete circle.__dragStartY;

    container.emit('confirm');
  });
}

/**
 * 监听非画图操作
 *
 * @param {Container} container
 */
function onManipulate(container) {
  const stage = container.get('stage');
  const layer = container.get('layer');
  const panelEl = container.get('panelEl');

  const canCursor = (evt) => {
    return canDraw(container, evt.target)
          && container.get('step') === 0;
  };

  layer.on('mouseover', 'Group', (evt) => {
    const { currentTarget: group } = evt;
    const selectedGroup = container.get('selectedGroup');

    // 未确定的状态不能操作
    if (container.get('state')
        || container.get('action')
        || group === selectedGroup) {
      return;
    }

    displayGroup(
      container,
      group,
      { hover: true },
    );
  });

  layer.on('mouseout', 'Group', (evt) => {
    const group = evt.currentTarget;
    if (!group.__hover) {
      return;
    }

    displayGroup(
      container,
      group,
      { hover: false },
    );
  });

  stage.on('mouseenter', (evt) => {
    if (!canCursor(evt)) {
      return;
    }
    container.emit('cursorBalloon');
  });

  stage.on('mousemove', (evt) => {
    displayCursorBalloon(container, canCursor(evt) ? evt.evt : 0);
  });

  stage.on('mouseleave', (evt) => {
    if (!canCursor(evt)) {
      return;
    }
    // 隐藏气泡
    displayCursorBalloon(container);
  });

  const onkeydown = (evt) => {
    if ((evt.keyCode || evt.which) === 8) {
      container.deleteSelectedGroup();
    }
  };
  on(panelEl, 'keydown', onkeydown);

  container.on('beforeDestroy', () => {
    off(panelEl, 'keydown', onkeydown);
  });
}

/**
 * 设置坐标
 *
 * @param {Container} container
 * @param {object[]} newValue
 * @returns {boolean} 是否设置了value
 */
function setValue(container, newValue) {
  // 数组不相等的情况下才更新
  if (valueEquals(container.get('value'), newValue)) {
    return false;
  }

  const layer = container.get('layer');
  layer.destroyChildren();

  // 图形配置
  const shapeConfig = container.get('shapeConfig');
  const defaults = container.get('defaultShapeConfig');

  // 创建图形
  newValue.forEach((p) => {
    const { type, direction, points } = p;

    const group = new Group({
      name: type
    });

    // 当前图形配置
    const currentShapeConfig = type ? shapeConfig[type] : defaults;

    // 先画多边形
    let shape = new LastSectionDashLine({
      name: CATEGORY_POLY,
      stroke: currentShapeConfig.stroke,
      strokeWidth: currentShapeConfig.strokeWidth,
      fill: currentShapeConfig.fill,
      closed: true,
      points
    });

    group.add(shape);
    // 上环
    eachPoint(points, (x, y, pointIndex, pointStart) => {
      addCircle(group, CATEGORY_POLY, pointStart, currentShapeConfig, x, y, false, true);
    });
    layer.add(group);

    // 画箭头
    shape = new Arrow({
      name: CATEGORY_ARROW,
      stroke: currentShapeConfig.stroke,
      strokeWidth: currentShapeConfig.strokeWidth,
      points: direction,
      fill: currentShapeConfig.stroke,
      pointerAtBeginning: !!currentShapeConfig.pointerAtBeginning
    });

    group.add(shape);
    // 上环
    eachPoint(direction, (x, y, pointIndex, pointStart) => {
      addCircle(group, CATEGORY_ARROW, pointStart, currentShapeConfig, x, y, false, true);
    });

    // 暂存图形配置
    group.__shapeConfig = currentShapeConfig;

    // 暂存坐标
    group.__direction = direction;
    group.__points = points;

    layer.add(group);
  });

  resetInternalProps(container);

  // 重置数组
  const drews = newValue.length;
  container
    .set('value', newValue)
    .set('drews', drews);

  return true;
}

/**
 * 重置内部属性
 * @param {Container} container
 */
function resetInternalProps(container) {
  return container
    .set('drews', 0)
    .set('step', 0)
    .set('state', null) // 当前图形状态
    .set('action', null) // 画图行为状态
    .set('category', null) // 当前所画的图形
    .set('prevShape', null) // 画图前的上一个图形
    .set('currentShape', null) // 当前正在画的图形
    .set('currentPoints', null) // 当前坐标数组
    .set('selectedGroup', null); // 当前选中的图形组
}

/**
 * 更新 value
 * @param {Container} container
 * @param {string} type
 * @param {string|undefined} category
 * @param {number[]|undefined} points
 * @returns {number[]}
 */
function updateValue(container, type, category, points) {
  const value = container.get('value');
  const index = value.findIndex((n) => n.type === type);

  if (index > -1) {
    if (category) {
      checkCategory(category, () => { // 多边形
        value[index].points = points;
      }, () => { // 箭头
        value[index].direction = points;
      });
    }
    else {
      value.splice(index, 1);
    }
  }

  return value;
}


/**
 * 检查图形分类
 *
 * @param {string} category
 * @param {function} doPoly
 * @param {function} doArrow
 */
function checkCategory(category, doPoly, doArrow) {
  switch (category) {
    case CATEGORY_POLY:
      doPoly();
      break;
    case CATEGORY_ARROW:
      doArrow();
      break;
    default:
      throw new Error(`未知的图形分类 ${category}`);
  }
}


/**
 * 还原图形位置
 *
 * @param {KonvaNode} group
 * @param {number[]} points
 * @param {number[]} direction
 */
function restorePosition(group, points, direction) {
  group.getChildren((node) => {
    switch (node.getClassName()) {
      case 'LastSectionDashLine':
        node.points(points);
        break;
      case 'Arrow':
        node.points(direction);
        break;
      case 'Circle': {
        const { __pointStart } = node;
        let x;
        let y;
        checkCategory(node.name(), () => {
          x = points[__pointStart];
          y = points[__pointStart + 1];
        }, () => {
          x = direction[__pointStart];
          y = direction[__pointStart + 1];
        });
        node.absolutePosition({ x, y });
        break;
      }
      default:
        throw new Error(`未知的图形 ${node.getClassName()}`);
    }
  });
}

/**
 * 确认修改
 * @param {Container} container
 * @param {boolean} bool
 */
function resolveChanges(container, bool) {
  // 隐藏确认浮层
  displayConfirmation(container);

  const action = container.get('action');
  switch (action) {
    case ACTION_DRAW: // 画图
      checkCategory(container.get('category'), () => { // 区域
        if (bool) {
          resolveDrewPoly(container);
        }
        else {
          rejectDrewPoly(container);
        }
      }, () => { // 方向
        if (bool) {
          resolveDrewArrow(container);
        }
        else {
          rejectDrewArrow(container);
        }
      });
      break;

    case ACTION_DRAG: // 拖拽
      // break omitted
    case ACTION_RECTIFY: // 调整大小
      if (bool) {
        resolveDragged(container);
      }
      else {
        rejectDragged(container);
      }
      break;

    default:
  }
}

/**
 * 确认画多边形
 *
 * @param {Container} container
 */
function resolveDrewPoly(container) {
  const selectedGroup = container.get('selectedGroup');
  const type = container.get('type');
  const category = container.get('category');
  const currentShape = container.get('currentShape');
  const prevShape = container.get('prevShape');

  const { __prePoints, __points } = selectedGroup;

  // 画完一个图形后直接确认
  if (__prePoints) {
    container.get('value').push({
      type,
      points: __prePoints
    });
    container
      .set('prevShape', currentShape);

    selectedGroup.__points = __prePoints;
    delete selectedGroup.__prePoints;
  }
  else { // 拖动或者调整大小后确认
    container
      .set('prevShape', prevShape)
      .set('value', updateValue(
        container,
        type,
        category,
        __points,
      ));
  }

  container
    .set('step', 0)
    .set('action', null)
    .set('state', STATE_DRAWING)
    .set('currentShape', null)
    .set('currentPoints', null)
    .set('category', CATEGORY_ARROW);

  container.emit('resolveDrewPoly');
}

/**
 * 取消当前多边形
 *
 * @param {Container} container
 */
function rejectDrewPoly(container) {
  const currentShape = container.get('currentShape');
  const group = currentShape.getParent();
  group.destroy();
  container.get('layer').batchDraw();

  const drews = container.get('drews');
  resetInternalProps(container)
    .set('drews', drews);
}

/**
 * 确认画箭头
 *
 * @param {Container} container
 */
function resolveDrewArrow(container) {
  const selectedGroup = container.get('selectedGroup');
  const { __preDirection } = selectedGroup;

  selectedGroup.__direction = __preDirection;
  selectedGroup.draggable(false);

  displayGroup(
    container,
    selectedGroup,
    { circle: false, hover: true },
  );

  // 更新 value
  const value = updateValue(
    container,
    container.get('type'),
    CATEGORY_ARROW,
    __preDirection,
  );

  // 重置内部属性
  const drews = container.get('drews');
  delete selectedGroup.__preDirection;
  resetInternalProps(container)
    .set('drews', drews + 1);

  // 转换 value
  const newValue = transformValue(container, value);

  container.emit('resolveDrewArrow');
  container.emit('change', newValue);
}

/**
 * 取消当前箭头
 *
 * @param {Container} container
 */
function rejectDrewArrow(container) {
  const selectedGroup = container.get('selectedGroup');
  const currentShape = container.get('currentShape');

  delete selectedGroup.__preDirection;
  delete selectedGroup.__direction;

  // 销毁环
  currentShape
    .getParent()
    .find(`.${currentShape.name()}`)
    .destroy();

  container.get('layer').batchDraw();

  container
    .set('step', 0)
    .set('action', null)
    .set('state', STATE_DRAWING)
    .set('currentShape', null)
    .set('currentPoints', null)
    .set('category', CATEGORY_ARROW);
}

/**
 * 确认拖动调整
 *
 * @param {Container} container
 */
function resolveDragged(container) {
  const selectedGroup = container.get('selectedGroup');
  const type = selectedGroup.name();
  const { __prePoints, __preDirection, __direction } = selectedGroup;

  let value;
  selectedGroup.getChildren((shape) => {
    if (shape.getClassName() !== 'Circle') {
      const points = shape.points();
      const category = shape.name();

      checkCategory(category, () => {
        // 未画完多边形调整位置或大小的情况
        if (__prePoints) {
          selectedGroup.__prePoints = points;
        }
        selectedGroup.__points = points;
      }, () => {
        // 未画完箭头调整位置或大小的情况
        if (__preDirection) {
          selectedGroup.__preDirection = points;
        }
        selectedGroup.__direction = points;
      });

      // 更新 value
      value = updateValue(container, type, category, points);
    }
  });

  // 刚画完图后的调整图形大小或者位置的确认
  if (__preDirection) {
    resolveDrewArrow(container);
    return;
  }
  else if (__prePoints || !__direction) { // 多边形未完成情况
    resolveDrewPoly(container);
    return;
  }

  displayGroup(
    container,
    selectedGroup,
    { circle: false, hover: true },
  );

  container
    .set('state', null)
    .set('action', null)
    .set('currentPoints', null)
    .set('currentShape', null)
    .set('selectedGroup', null);

  container.emit('change', transformValue(container, value), container);
}

/**
 * 取消拖拽调整
 *
 * @param {Container} container
 */
function rejectDragged(container) {
  // 取消调整图形位置
  const selectedGroup = container.get('selectedGroup');
  const { __prePoints, __points, __preDirection, __direction } = selectedGroup;

  // 调整图形大小或者位置后取消
  if (__preDirection) {
    rejectDrewArrow(container);
    restorePosition(selectedGroup, __points, __direction);
    return;
  }
  else if (__prePoints) { // 多边形未完成情况
    rejectDrewPoly(container);
    return;
  }

  // 还原图形位置
  restorePosition(selectedGroup, __points, __direction);

  container.get('layer').batchDraw();

  container
    .set('state', null)
    .set('action', null);
}
