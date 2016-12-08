'use strict';

const ApiController = require('..').Api

class PathController extends ApiController {
  constructor(ctx, next) {
    super(ctx, next)
  }
  
  get() { 
    var a = this.query.a
    
    return {
      dddd:1,
      b: a
    }
  } 
}

PathController.path = '/b'

module.exports = PathController