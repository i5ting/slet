'use strict'
var debug = require('debug')('slet')

const http = require('http')
const fs = require('fs')
const resolve = require('path').resolve
const Koa = require('koa')
const methods = require('methods')
const slice = Array.prototype.slice
const router = require('koa-router')()
const bodyParser = require('koa-bodyparser')
const compose = require('koa-compose')
const parseController = require('parsecontroller')
// local
const defaultConfig = require('./config')
const _ctx = defaultConfig.mockCtx
const _next = function () {}

class Slet {
  constructor (opts) {
    this.opts = Object.assign(defaultConfig, opts)

    this.viewPath = resolve(this.opts.root, this.opts.views.path)

    //
    this.app = new Koa()
    this.routes = []
    this.controllers = []
    this.scanedControllerArray = [] // 扫码opts.root得到的所有的controller信息
    this.controllerDependency = []
    this.middlewares = {}

    if (this.opts.debug === true) {
      console.log(this.opts)
    }

    let self = this

    self._initMiddleware()
    self.routerDir(this.opts.automount.path)
  }

  identifyDept () {
    let self = this
    return new Promise(function (resolve, reject) {
      // console.log(self.opts.root)
      parseController(self.opts.root, function (resultArray) {
        // console.log(resultArray)
        self.scanedControllerArray = resultArray
        resolve(resultArray)
      })
    })
  }

  buildDept (path) {
    let self = this
    return new Promise(function (resolve, reject) {
      parseController(path, function (resultArray) {
        // console.log(resultArray)
        resolve(resultArray)
      })
    }).then(function (resultArray) {
      // console.log(resultArray)
      for (var i in resultArray) {
        var lib = resultArray[i].dep_controller
        self.defineController(require(lib))
      }
    })
  }

  _initMiddleware () {
    this.middlewares['koa-bodyparser'] = bodyParser()
  }

  defineMiddleware (name, fn) {
    this.middlewares[name] = fn
  }

  defineController (controller) {
    if (typeof controller === 'function') {
      this.controllers.push(controller)
      this._registerControllerClass(controller)
    } else {
      console.log('please use class Controller')
    }
  }

  // global middleware && application filter
  use (middleware) {
    this.app.use(middleware)
  }

  routerDir (dir) {
    var self = this
    this.routerPath = resolve(this.opts.root, dir)

    if (fs.existsSync(this.routerPath) === false) {
      if (this.opts.debug === true) console.log('router path is not exists: ' + this.routerPath)
      return
    }

    return self.buildDept(self.routerPath).then(function () {
      var requireDir = require('require-dir')
      var controllers = requireDir(self.routerPath, self.opts.automount.option)

      for (let i in controllers) {
        if (i === '.git' || i === 'package.json') {
          return
        }

        let Controller = controllers[i]
        let mockCtx = new Controller(self, _ctx, _next)
        // 兼容static.path
        if (Controller.path) self.router(Controller)
        // 兼容object.path
        else if (mockCtx.path) self.router(Controller)
        // warn log
        else console.warn('[WARNING] routerDir at ' + self.routerPath + ' no path config in ' + Controller)
      }
    })
  }

  asyncRouter (cb) {
    let self = this
    return self.buildDept(this.opts.root).then(function () {
      // must before this.routerDir()
      cb()
    })
  }

  router () {
    let self = this
    let path, controller

    if (arguments.length === 1) {
      // (controller)
      // path = arguments[0] from controller.path
      controller = arguments[0]
    } else if (arguments.length >= 2) {
      // (path, controller)
      path = arguments[0]
      controller = arguments[1]
    } else {
      console.log('error')
    }

    var Controller = controller
    if (typeof controller === 'string') {
      // 注意.ctrl && ctrl
      // file.exists
      let file = resolve(this.opts.root, controller)
      // console.log(file)
      // 自动注入依赖
      var _file = /.js$/.test(file) ? file : file + '.js'
      var info = parseController(_file)
      // console.log(info)
      self.defineController(require(info.dep_controller))
      Controller = require(file)
    }

    let lib = this._getControllerBaseName(Controller)
    this.controllerDependency.push(lib)

    if (this.opts.auto) {
      this.defineController(require(lib))
    }

    var mockCtx = new Controller(self, _ctx, _next)
    var avaiableMethods = this._avaiableMethods(mockCtx)

    // 如果attr controller this.path =xxx
    if (!path && mockCtx.path) {
      path = mockCtx.path
    }

    // 如果static controller.path =xxx
    if (!path) {
      path = Controller.path
    }

    if (!path) {
      console.log('you must spec a path to controller')
    }

    if (this.opts.debug) {
      let t = (Controller + '').split(' extends')[0]

      this.routes.push({
        path: path,
        class: controller,
        avaiableMethods: avaiableMethods,
        type: t,
        global_filter: mockCtx.global_filter
      })
    }

    router.all(path, function (ctx, next) {
      let verb = ctx.request.method.toLowerCase()
      var ctrl = new Controller(self, ctx, next)
      debug(ctx.request.method)
      debug(ctx.request.path)

      var match = avaiableMethods.find(function (n) {
        return n === verb
      })
      if (!match) {
        console.log(path + ' ' + (Controller + '').split(' extends')[0] + ' #' + verb + '() not impl')
        ctx.body = {
          code: 1,
          msg: {
            'text': path + ' ' + verb + ' not impl',
            'controller': (Controller + '').split(' extends')[0]
          }
        }

        return ctx.body
      }

      var _middlewares = []

      for (var i in ctrl.global_filter) {
        _middlewares.push(self.middlewares[ctrl.global_filter[i]])
      }

      debug(_middlewares)

      let filter = ctrl[verb + '_filter'] || []
      for (var j in filter) {
        _middlewares.push(filter[j])
      }

      debug(_middlewares)

      _middlewares.push(function last (ctx, next) {
        let arg = slice.call(arguments, 1)

        // before
        ctrl.before()

        // alias this.xxx
        ctrl.alias()

        // execute {verb}()
        ctrl.result = ctrl[verb].apply(ctrl, arg)

        // renderType: default | view
        // ctrl.render()
        if (ctrl.renderType === 'default') {
          return new Promise(function (resolve, reject) {
            resolve(ctx.body = ctrl.result)
          }).then(function () {
            // after
            ctrl.after()
          })
        }

        if (ctrl.renderType === 'view') {
          var obj = {
            data: ctrl.data,
            tpl: ctrl.tpl
          }
          Object.assign(obj, ctrl.result)

          return ctx.render(obj.tpl, obj.data).then(function () {
            // after
            ctrl.after()
          })
        }

        // after
        // ctrl.after()
      })

      debug(_middlewares)

      return compose(_middlewares)(ctx, next).catch(function (error) {
        console.log(error)
      })
    })
  }

  _avaiableMethods (obj) {
    let m = Object.getOwnPropertyNames(Object.getPrototypeOf(obj))
    m.shift()

    let re = []
    // methods
    m.forEach(function (method) {
      var a = methods.find(function (n) {
        return n === method
      })
      if (a) re.push(a)
    })

    return re
  }

  _getControllerName (Controller) {
    let i = (Controller + '').split(' extends')[0]
    return i.split('{')[0].replace('class', '').trim()
  }

  _getControllerBaseName (Controller) {
    let i = (Controller + '').split(' extends')[1]

    let j = i.split('{')[0]

    let base = j.trim()

    debug('slet-' + base.toLowerCase())

    return 'slet-' + base.toLowerCase()
  }

  _registerControllerClass (Controller) {
    let clz = this._getControllerName(Controller)
    Slet[clz] = Controller
  }

  start () {
    if (this.opts.debug) {
      console.log(this.routes)
      console.log(this.controllerDependency)
    }

    this.app
      .use(router.routes())
      .use(router.allowedMethods())

    debug('listen')
    const server = http.createServer(this.app.callback())
    return server.listen.apply(server, arguments)
  }

  listen () {
    return this.start()
  }

  run () {
    let self = this

    return this.start(function () {
      self.port = this.address().port
      console.log('Slet listening on port', this.address().port)
    })
  }

  plugin () {
    return Slet.plugin.call(Slet.plugin, arguments)
  }
}

Slet.plugin = function () {
  function _copyProperties (target, source) {
    for (let key of Reflect.ownKeys(source)) {
      if (key !== 'constructor' && key !== 'prototype' && key !== 'name') {
        let desc = Object.getOwnPropertyDescriptor(source, key)
        Object.defineProperty(target, key, desc)
      }
    }
  }

  for (let mixin of arguments) {
    _copyProperties(Slet, mixin)
    _copyProperties(Slet.prototype, mixin.prototype)
  }

  return Slet
}

module.exports = Slet
