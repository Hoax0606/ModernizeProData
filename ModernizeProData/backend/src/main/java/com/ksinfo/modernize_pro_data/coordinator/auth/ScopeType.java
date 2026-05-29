package com.ksinfo.modernize_pro_data.coordinator.auth;

/**
 * ApiCredential 의 scope.
 * - all          : 全 project 起動 가능 (案 A 의 default)
 * - project_list : scope_project_ids 列挙된 project 만 (案 C 用)
 */
public enum ScopeType {
    all,
    project_list
}
