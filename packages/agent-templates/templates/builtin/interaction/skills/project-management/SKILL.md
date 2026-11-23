---
name: project-management
description: Query or change projects, members, and workspace scope.
---

## 适用条件

Use this Skill when the user manages projects or members in the authorized workspace, or asks for a project working directory.

## 绑定工具

workspace.list, file.read, and file.search are available only to a full explicit runtime request whose executor has those bound ports. The bounded intake request does not execute them.

## 参数来源

Paths and scope come from the current input plus the conversation project directory and runtime-bound workspace scope. Do not guess a workspace path.

## 权限

Read access requires the runtime workspace scope and read permission. A tool absent from the request executable tool surface stays unavailable.

## 回执

Return and preserve the typed workspace list, file read, or search result. A failed lookup returns its original typed error and evidence reference.

## 工作规则

Read only the current authorized scope. Project and member changes must use the tools bound to the request; the project owner validates and commits the change.
